'use strict';

/**
 * @file ml-engine.js
 * @description Motor de clasificación basado en Naive Bayes Multinomial + TF-IDF.
 *
 * Persistencia: SQLite (via ZiloDatabase) en lugar de JSON.
 * El modelo se carga en memoria una vez y se actualiza de forma incremental
 * en SQLite tras cada entrenamiento — no hay escrituras completas del modelo.
 */

// ── Stopwords español ─────────────────────────────────────────────────────────
const STOPWORDS = new Set([
    'de','la','que','el','en','los','del','se','las','por','un','una','para',
    'con','su','al','lo','como','mas','pero','sus','le','ya','sin','sobre',
    'este','esta','esto','ese','esa','eso','si','porque','cuando','muy','me',
    'hasta','hay','donde','quien','desde','nos','durante','todos','uno','les',
    'ni','contra','otros','ante','ellos','estos','mucho','quienes','nada',
    'muchos','cual','poco','ella','estar','estas','algo','nosotros','mi','mis',
    'tu','tus','ellas','son','ser','fue','era','han','tener','tiene','tienen',
    'tuvo','tengo','hacer','hace','hecho','poder','puede','pueden','deber',
    'debe','decir','dijo','dice','ver','dar','saber','querer','llegar',
    'numero','fecha','total','euros','importe','dicho','dicha','mediante',
    'cada','tanto','mismo','misma','otro','otra','bien','entre','vez','tras',
]);

const MAX_CORPUS_SIZE = 2000;  // LRU-por-clase en SQLite
const MIN_TOKENS      = 5;
const MIN_DOCS_CLASS  = 2;

class MLEngine {
    /**
     * @param {import('./db')} db - Instancia de ZiloDatabase ya inicializada
     */
    constructor(db) {
        this._db         = db;
        this._model      = null;   // cargado en memoria bajo demanda
        this._writeQueue = Promise.resolve();  // serializa escrituras concurrentes
    }

    // ── Persistencia ──────────────────────────────────────────────────────────

    /** Carga el modelo desde SQLite en memoria (una vez por sesión). */
    _load() {
        if (this._model) return;
        this._model = this._db.mlLoad() || {
            version: 2, classes: {}, docFreq: {}, totalDocs: 0,
            corpus: [], lastTrained: null,
        };
    }

    /** Encola una operación de escritura para evitar races concurrentes. */
    _enqueue(fn) {
        this._writeQueue = this._writeQueue.then(fn).catch(e => {
            console.error('[ML] Error en cola de escritura:', e.message);
        });
        return this._writeQueue;
    }

    // ── Tokenización ──────────────────────────────────────────────────────────

    _tokenize(text) {
        return text
            .toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !STOPWORDS.has(w));
    }

    _termFreq(tokens) {
        const tf = {};
        for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
        return tf;
    }

    // ── Entrenamiento ─────────────────────────────────────────────────────────

    /**
     * Añade un documento de entrenamiento al modelo.
     * Actualiza la memoria Y persiste en SQLite de forma incremental.
     */
    train(text, className) {
        return new Promise((resolve) => {
            this._enqueue(() => {
                this._load();
                if (!text?.trim() || !className?.trim()) { resolve({ success: false }); return; }

                const tokens = this._tokenize(text);
                if (tokens.length < MIN_TOKENS) { resolve({ success: false, reason: 'too_short' }); return; }

                const m = this._model;

                // ── Actualizar modelo en memoria ──────────────────────────────
                if (!m.classes[className]) {
                    m.classes[className] = { wordCounts: {}, totalWords: 0, docCount: 0 };
                }
                const cls = m.classes[className];
                const tf  = this._termFreq(tokens);

                for (const [word, count] of Object.entries(tf)) {
                    cls.wordCounts[word]  = (cls.wordCounts[word]  || 0) + count;
                    cls.totalWords       += count;
                }
                cls.docCount++;
                m.totalDocs++;

                const uniqueTokens = new Set(tokens);
                for (const word of uniqueTokens) {
                    m.docFreq[word] = (m.docFreq[word] || 0) + 1;
                }

                // Corpus LRU-por-clase (en memoria)
                const corpusEntry = { tokens: tokens.slice(0, 250).join(' '), className };
                m.corpus.push(corpusEntry);
                if (m.corpus.length > MAX_CORPUS_SIZE) {
                    const classCounts = {};
                    m.corpus.forEach((e, i) => {
                        if (!classCounts[e.className]) classCounts[e.className] = [];
                        classCounts[e.className].push(i);
                    });
                    const mostFreqClass = Object.entries(classCounts)
                        .sort((a, b) => b[1].length - a[1].length)[0][0];
                    m.corpus.splice(classCounts[mostFreqClass][0], 1);
                }

                m.lastTrained = new Date().toISOString();

                // ── Persistir en SQLite de forma incremental ──────────────────
                try {
                    this._db.mlSaveTrain({
                        className,
                        tf,
                        uniqueTokens,
                        totalDocs:      m.totalDocs,
                        lastTrained:    m.lastTrained,
                        corpusEntry,
                        maxCorpusSize:  MAX_CORPUS_SIZE,
                    });
                } catch (e) {
                    console.error('[ML] Error al persistir entrenamiento:', e.message);
                }

                resolve({ success: true, totalDocs: m.totalDocs, classCount: cls.docCount });
            });
        });
    }

    // ── Clasificación ─────────────────────────────────────────────────────────

    classify(text) {
        this._load();
        const m = this._model;

        const classNames = Object.keys(m.classes).filter(
            c => m.classes[c].docCount >= MIN_DOCS_CLASS
        );

        if (m.totalDocs < 4 || classNames.length === 0) {
            return { type: null, confidence: 0, confianza: 'low', reason: 'insufficient_data' };
        }

        const tokens = this._tokenize(text);
        if (tokens.length < MIN_TOKENS) {
            return { type: null, confidence: 0, confianza: 'low', reason: 'text_too_short' };
        }

        // ── Naive Bayes Multinomial ───────────────────────────────────────────
        const vocabSize = Object.keys(m.docFreq).length;
        const nbScores  = {};

        for (const className of classNames) {
            const cls = m.classes[className];
            let score = Math.log(cls.docCount / m.totalDocs);
            for (const token of tokens) {
                const count  = cls.wordCounts[token] || 0;
                const pToken = (count + 1) / (cls.totalWords + vocabSize);
                score       += Math.log(pToken);
            }
            nbScores[className] = score;
        }

        // Softmax
        const maxScore = Math.max(...Object.values(nbScores));
        let sumExp = 0;
        const expMap = {};
        for (const [cls, sc] of Object.entries(nbScores)) {
            expMap[cls] = Math.exp(sc - maxScore);
            sumExp     += expMap[cls];
        }
        const nbProbs = {};
        for (const cls of classNames) {
            nbProbs[cls] = sumExp > 0 ? expMap[cls] / sumExp : 0;
        }

        const nbSorted = [...classNames].sort((a, b) => nbProbs[b] - nbProbs[a]);
        const nbBest   = nbSorted[0];
        const nbConf   = nbProbs[nbBest] || 0;

        // ── TF-IDF + Cosine Similarity ────────────────────────────────────────
        const tfidf = this._classifyTFIDF(tokens, m);

        // ── Combinar señales ──────────────────────────────────────────────────
        let finalType = nbBest;
        let finalConf = nbConf;

        if (tfidf.type) {
            if (tfidf.type === nbBest) {
                finalConf = Math.min(1, finalConf * 1.10);
            } else if (tfidf.similarity > 0.65) {
                finalConf *= 0.80;
            }
        }

        const docCount = m.classes[finalType]?.docCount || 0;
        if (docCount < 5)  finalConf *= 0.70;
        if (docCount < 10) finalConf *= 0.90;

        const confianza = finalConf >= 0.80 ? 'high' : finalConf >= 0.50 ? 'medium' : 'low';

        return {
            type:         finalType,
            confidence:   Math.round(finalConf * 1000) / 1000,
            confianza,
            alternatives: nbSorted.slice(1, 3).map(c => ({ type: c, confidence: nbProbs[c] })),
            tfidfSignal:  tfidf,
            docCount,
            source:       'ml',
            reason:       'classified',
        };
    }

    // ── TF-IDF + Cosine Similarity ────────────────────────────────────────────

    _classifyTFIDF(tokens, m) {
        if (m.corpus.length < 4) return { type: null, similarity: 0 };

        const tf       = this._termFreq(tokens);
        const queryVec = {};
        for (const [word, count] of Object.entries(tf)) {
            const df = m.docFreq[word] || 0;
            if (df === 0) continue;
            queryVec[word] = (count / tokens.length) * Math.log((m.totalDocs + 1) / (df + 1));
        }

        const classSim   = {};
        const classCount = {};

        for (const doc of m.corpus) {
            const dTokens = doc.tokens.split(' ');
            const dTF     = this._termFreq(dTokens);
            const docVec  = {};
            for (const [word, count] of Object.entries(dTF)) {
                const df = m.docFreq[word] || 0;
                if (df === 0) continue;
                docVec[word] = (count / dTokens.length) * Math.log((m.totalDocs + 1) / (df + 1));
            }
            const sim = _cosine(queryVec, docVec);
            classSim[doc.className]   = (classSim[doc.className]   || 0) + sim;
            classCount[doc.className] = (classCount[doc.className] || 0) + 1;
        }

        let bestClass = null, bestSim = 0;
        for (const [cls, total] of Object.entries(classSim)) {
            const avg = total / classCount[cls];
            if (avg > bestSim) { bestSim = avg; bestClass = cls; }
        }

        return { type: bestClass, similarity: Math.round(bestSim * 1000) / 1000 };
    }

    // ── Estadísticas ──────────────────────────────────────────────────────────

    getStats() {
        // Usar SQLite directamente — más rápido y siempre actualizado
        return this._db.mlGetStats();
    }

    deleteClass(className) {
        // Actualizar memoria
        this._load();
        const m = this._model;
        if (m.classes[className]) {
            const docsOfClass = m.corpus.filter(d => d.className === className);
            for (const doc of docsOfClass) {
                for (const word of new Set(doc.tokens.split(' '))) {
                    if (m.docFreq[word] > 0) m.docFreq[word]--;
                }
            }
            m.totalDocs = Math.max(0, m.totalDocs - m.classes[className].docCount);
            m.corpus    = m.corpus.filter(d => d.className !== className);
            delete m.classes[className];
        }
        // Persistir en SQLite
        return this._db.mlDeleteClass(className);
    }

    reset() {
        this._model = {
            version: 2, classes: {}, docFreq: {}, totalDocs: 0,
            corpus: [], lastTrained: null,
        };
        return this._db.mlReset();
    }
}

// ── Utilidad: similitud de coseno ─────────────────────────────────────────────
function _cosine(v1, v2) {
    let dot = 0, n1 = 0, n2 = 0;
    for (const k of Object.keys(v1)) {
        const a = v1[k], b = v2[k] || 0;
        dot += a * b;
        n1  += a * a;
    }
    for (const v of Object.values(v2)) n2 += v * v;
    return (n1 === 0 || n2 === 0) ? 0 : dot / (Math.sqrt(n1) * Math.sqrt(n2));
}

module.exports = { MLEngine };
