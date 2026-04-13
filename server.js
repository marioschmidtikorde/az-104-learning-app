import express from "express";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "learning.db");

let questions = [];
let db;

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readQuestionBank() {
  const yamlPath = path.join(__dirname, "questions.yaml");
  const jsonPath = path.join(__dirname, "questions.json");

  if (fileExists(yamlPath)) {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = yaml.load(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("questions.yaml is invalid. Expected a top-level object.");
    }

    if (!Array.isArray(parsed.questions)) {
      throw new Error("questions.yaml is invalid. Expected a top-level 'questions' array.");
    }

    return parsed.questions.map(normalizeYamlQuestion);
  }

  if (fileExists(jsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

    if (!Array.isArray(parsed)) {
      throw new Error("questions.json is invalid. Expected a top-level array.");
    }

    return parsed.map(normalizeJsonQuestion);
  }

  throw new Error("Neither questions.yaml nor questions.json was found.");
}

function normalizeYamlQuestion(q, index) {
  const missing = [];

  if (!q || typeof q !== "object") missing.push("question object");
  if (!q?.id) missing.push("id");
  if (!q?.domain) missing.push("domain");
  if (!q?.question) missing.push("question");
  if (!Array.isArray(q?.choices)) missing.push("choices");
  if (typeof q?.correct_answer_index !== "number") missing.push("correct_answer_index");
  if (!q?.explanation) missing.push("explanation");

  if (missing.length) {
    throw new Error(
      `questions.yaml entry at index ${index} is missing required fields: ${missing.join(", ")}`
    );
  }

  if (q.correct_answer_index < 0 || q.correct_answer_index >= q.choices.length) {
    throw new Error(
      `questions.yaml entry '${q.id}' has invalid correct_answer_index ${q.correct_answer_index}.`
    );
  }

  const refs = [];
  if (q.source?.url) refs.push(q.source.url);
  if (q.source?.title) refs.push(`Source: ${q.source.title}`);

  return {
    id: q.id,
    topic: q.domain,
    question: q.question,
    choices: q.choices,
    correctIndex: q.correct_answer_index,
    explanation: q.explanation,
    refs
  };
}

function normalizeJsonQuestion(q, index) {
  const missing = [];

  if (!q || typeof q !== "object") missing.push("question object");
  if (!q?.id) missing.push("id");
  if (!q?.topic) missing.push("topic");
  if (!q?.question) missing.push("question");
  if (!Array.isArray(q?.choices)) missing.push("choices");
  if (typeof q?.correctIndex !== "number") missing.push("correctIndex");
  if (!q?.explanation) missing.push("explanation");

  if (missing.length) {
    throw new Error(
      `questions.json entry at index ${index} is missing required fields: ${missing.join(", ")}`
    );
  }

  return {
    id: q.id,
    topic: q.topic,
    question: q.question,
    choices: q.choices,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    refs: Array.isArray(q.refs) ? q.refs : []
  };
}

function shuffle(arr) {
  const clone = [...arr];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

function getQuestionById(questionId) {
  return questions.find((q) => q.id === questionId);
}

function buildQuestionPayload(question) {
  return {
    id: question.id,
    topic: question.topic,
    question: question.question,
    choices: question.choices
  };
}

function normalizeDomains(inputDomains) {
  if (!Array.isArray(inputDomains) || !inputDomains.length) {
    return [];
  }

  const allowed = new Set(questions.map((q) => q.topic));
  return [...new Set(
    inputDomains
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean)
      .filter((domain) => allowed.has(domain))
  )];
}

function getQuestionPool(domains) {
  if (!domains.length) {
    return [...questions];
  }
  return questions.filter((q) => domains.includes(q.topic));
}

function parseMode(input) {
  const mode = typeof input === "string" ? input.trim().toLowerCase() : "practice";
  return mode === "exam" ? "exam" : "practice";
}

function buildSessionQuestionSet(pool, requestedCount) {
  const shuffled = shuffle(pool);
  return shuffled.slice(0, Math.min(requestedCount, shuffled.length));
}

async function initializeDatabase() {
  ensureDirectory(dataDir);

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      domains_json TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      answered_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      score_percent REAL NOT NULL DEFAULT 0,
      cut_percent REAL NOT NULL,
      passed INTEGER,
      duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS session_questions (
      session_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      question_order INTEGER NOT NULL,
      PRIMARY KEY (session_id, question_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS session_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      selected_choice_index INTEGER NOT NULL,
      correct_choice_index INTEGER NOT NULL,
      is_correct INTEGER NOT NULL,
      answered_at TEXT NOT NULL,
      response_time_ms INTEGER,
      UNIQUE (session_id, question_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

function loadQuestions() {
  questions = readQuestionBank();
  console.log(`Loaded ${questions.length} questions.`);
}

function createSessionId() {
  return `session-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function clampPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.floor(num);
}

function calculatePercent(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function getSessionById(sessionId) {
  return db.get(`SELECT * FROM sessions WHERE id = ?`, sessionId);
}

async function getSessionQuestionIds(sessionId) {
  const rows = await db.all(
    `SELECT question_id FROM session_questions WHERE session_id = ? ORDER BY question_order ASC`,
    sessionId
  );
  return rows.map((row) => row.question_id);
}

async function getSessionAnswers(sessionId) {
  return db.all(
    `SELECT question_id, domain, selected_choice_index, correct_choice_index, is_correct, answered_at, response_time_ms
     FROM session_answers
     WHERE session_id = ?
     ORDER BY answered_at ASC`,
    sessionId
  );
}

async function finalizeSession(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session) {
    return null;
  }

  const answers = await getSessionAnswers(sessionId);
  const correctCount = answers.filter((row) => row.is_correct === 1).length;
  const answeredCount = answers.length;
  const scorePercent = calculatePercent(correctCount, session.question_count);
  const cutPercent = Number(session.cut_percent);
  const endedAt = new Date().toISOString();
  const durationSeconds = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 1000)
  );
  const passed = answeredCount === session.question_count ? Number(scorePercent >= cutPercent) : 0;

  await db.run(
    `UPDATE sessions
     SET answered_count = ?, correct_count = ?, score_percent = ?, passed = ?, ended_at = ?, duration_seconds = ?, status = 'completed'
     WHERE id = ?`,
    answeredCount,
    correctCount,
    scorePercent,
    passed,
    endedAt,
    durationSeconds,
    sessionId
  );

  return db.get(`SELECT * FROM sessions WHERE id = ?`, sessionId);
}

async function getSessionDomainBreakdown(sessionId) {
  const rows = await db.all(
    `SELECT domain,
            COUNT(*) AS answered_count,
            SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
     FROM session_answers
     WHERE session_id = ?
     GROUP BY domain
     ORDER BY domain ASC`,
    sessionId
  );

  return rows.map((row) => ({
    domain: row.domain,
    answeredCount: Number(row.answered_count),
    correctCount: Number(row.correct_count),
    accuracyPercent: calculatePercent(Number(row.correct_count), Number(row.answered_count))
  }));
}

function serializeSessionRow(row) {
  return {
    id: row.id,
    mode: row.mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    domains: JSON.parse(row.domains_json),
    questionCount: Number(row.question_count),
    answeredCount: Number(row.answered_count),
    correctCount: Number(row.correct_count),
    scorePercent: Number(row.score_percent),
    cutPercent: Number(row.cut_percent),
    passed: row.passed === null ? null : row.passed === 1,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    status: row.status
  };
}

async function buildSessionDetail(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session) {
    return null;
  }

  const questionIds = await getSessionQuestionIds(sessionId);
  const answers = await getSessionAnswers(sessionId);
  const answerMap = new Map(answers.map((answer) => [answer.question_id, answer]));

  const questionSet = questionIds
    .map((questionId) => getQuestionById(questionId))
    .filter(Boolean)
    .map((question) => {
      const answer = answerMap.get(question.id);
      return {
        ...buildQuestionPayload(question),
        explanation: question.explanation,
        refs: question.refs,
        answer: answer
          ? {
              selectedChoiceIndex: Number(answer.selected_choice_index),
              correctChoiceIndex: Number(answer.correct_choice_index),
              isCorrect: answer.is_correct === 1,
              answeredAt: answer.answered_at,
              responseTimeMs: answer.response_time_ms === null ? null : Number(answer.response_time_ms)
            }
          : null
      };
    });

  return {
    session: serializeSessionRow(session),
    questions: questionSet,
    domainBreakdown: await getSessionDomainBreakdown(sessionId)
  };
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_req, res) => {
  const totalSessionsRow = await db.get(`SELECT COUNT(*) AS total_sessions FROM sessions`);
  res.json({
    status: "ok",
    questionCount: questions.length,
    topics: [...new Set(questions.map((q) => q.topic))].sort((a, b) => a.localeCompare(b)),
    totalSessions: Number(totalSessionsRow.total_sessions)
  });
});

app.get("/api/topics", (_req, res) => {
  const topics = [...new Set(questions.map((q) => q.topic))].sort((a, b) => a.localeCompare(b));
  res.json({ topics });
});

app.get("/api/question", (req, res) => {
  const topic = (req.query.topic || "").toString().trim();
  const pool = topic ? questions.filter((q) => q.topic === topic) : questions;

  if (!pool.length) {
    return res.status(404).json({ error: "No questions for this topic." });
  }

  const question = shuffle(pool)[0];
  return res.json(buildQuestionPayload(question));
});

app.post("/api/answer", (req, res) => {
  const { id, choiceIndex } = req.body ?? {};
  const question = questions.find((x) => x.id === id);

  if (!question) {
    return res.status(404).json({ error: "Unknown question id." });
  }

  if (typeof choiceIndex !== "number") {
    return res.status(400).json({ error: "choiceIndex must be a number." });
  }

  const correct = choiceIndex === question.correctIndex;

  return res.json({
    correct,
    correctIndex: question.correctIndex,
    explanation: question.explanation,
    refs: question.refs
  });
});

app.post("/api/sessions", async (req, res) => {
  const mode = parseMode(req.body?.mode);
  const domains = normalizeDomains(req.body?.domains);
  const defaultQuestionCount = mode === "exam" ? 20 : 10;
  const questionCount = clampPositiveInt(req.body?.questionCount, defaultQuestionCount);
  const cutPercent = Number.isFinite(Number(req.body?.cutPercent)) ? Number(req.body.cutPercent) : 70;
  const pool = getQuestionPool(domains);

  if (!pool.length) {
    return res.status(400).json({ error: "No questions available for the selected domains." });
  }

  const selectedQuestions = buildSessionQuestionSet(pool, questionCount);
  if (!selectedQuestions.length) {
    return res.status(400).json({ error: "Could not create a session with the selected settings." });
  }

  const sessionId = createSessionId();
  const startedAt = new Date().toISOString();

  await db.run(
    `INSERT INTO sessions (
      id, mode, started_at, domains_json, question_count, answered_count, correct_count, score_percent, cut_percent, passed, duration_seconds, status
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, NULL, NULL, 'active')`,
    sessionId,
    mode,
    startedAt,
    JSON.stringify(domains),
    selectedQuestions.length,
    cutPercent
  );

  for (const [index, question] of selectedQuestions.entries()) {
    await db.run(
      `INSERT INTO session_questions (session_id, question_id, question_order) VALUES (?, ?, ?)`,
      sessionId,
      question.id,
      index
    );
  }

  return res.status(201).json({
    sessionId,
    mode,
    startedAt,
    domains,
    questionCount: selectedQuestions.length,
    cutPercent,
    questions: selectedQuestions.map(buildQuestionPayload)
  });
});

app.post("/api/sessions/:id/answers", async (req, res) => {
  const sessionId = req.params.id;
  const session = await getSessionById(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Unknown session id." });
  }

  if (session.status !== "active") {
    return res.status(400).json({ error: "This session is already completed." });
  }

  const { questionId, selectedChoiceIndex, responseTimeMs } = req.body ?? {};
  const questionIds = await getSessionQuestionIds(sessionId);

  if (!questionIds.includes(questionId)) {
    return res.status(400).json({ error: "Question does not belong to this session." });
  }

  const question = getQuestionById(questionId);
  if (!question) {
    return res.status(404).json({ error: "Unknown question id." });
  }

  if (typeof selectedChoiceIndex !== "number") {
    return res.status(400).json({ error: "selectedChoiceIndex must be a number." });
  }

  if (selectedChoiceIndex < 0 || selectedChoiceIndex >= question.choices.length) {
    return res.status(400).json({ error: "selectedChoiceIndex is out of range." });
  }

  const isCorrect = Number(selectedChoiceIndex === question.correctIndex);
  const answeredAt = new Date().toISOString();

  try {
    await db.run(
      `INSERT INTO session_answers (
        session_id, question_id, domain, selected_choice_index, correct_choice_index, is_correct, answered_at, response_time_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      questionId,
      question.topic,
      selectedChoiceIndex,
      question.correctIndex,
      isCorrect,
      answeredAt,
      Number.isFinite(Number(responseTimeMs)) ? Number(responseTimeMs) : null
    );
  } catch (_error) {
    return res.status(409).json({ error: "This question was already answered in the session." });
  }

  const answerCountRow = await db.get(
    `SELECT COUNT(*) AS answer_count FROM session_answers WHERE session_id = ?`,
    sessionId
  );
  const totalQuestionIds = await getSessionQuestionIds(sessionId);

  let updatedSession;
  let domainBreakdown = [];
  if (Number(answerCountRow.answer_count) >= totalQuestionIds.length) {
    updatedSession = await finalizeSession(sessionId);
    domainBreakdown = await getSessionDomainBreakdown(sessionId);
  } else {
    updatedSession = await getSessionById(sessionId);
  }

  return res.json({
    correct: isCorrect === 1,
    correctIndex: question.correctIndex,
    explanation: question.explanation,
    refs: question.refs,
    session: serializeSessionRow(updatedSession),
    domainBreakdown
  });
});

app.post("/api/sessions/:id/complete", async (req, res) => {
  const session = await getSessionById(req.params.id);

  if (!session) {
    return res.status(404).json({ error: "Unknown session id." });
  }

  const completed = session.status === "completed" ? session : await finalizeSession(req.params.id);

  return res.json({
    session: serializeSessionRow(completed),
    domainBreakdown: await getSessionDomainBreakdown(req.params.id)
  });
});

app.get("/api/sessions", async (req, res) => {
  const limit = Math.min(clampPositiveInt(req.query.limit, 20), 100);
  const rows = await db.all(
    `SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`,
    limit
  );

  return res.json({
    sessions: rows.map(serializeSessionRow)
  });
});

app.get("/api/sessions/:id", async (req, res) => {
  const detail = await buildSessionDetail(req.params.id);

  if (!detail) {
    return res.status(404).json({ error: "Unknown session id." });
  }

  return res.json(detail);
});

app.get("/api/stats/overview", async (_req, res) => {
  const totals = await db.get(`
    SELECT
      COUNT(*) AS total_sessions,
      SUM(question_count) AS total_questions,
      SUM(answered_count) AS answered_questions,
      SUM(correct_count) AS correct_answers,
      SUM(CASE WHEN mode = 'exam' THEN 1 ELSE 0 END) AS exam_sessions,
      SUM(CASE WHEN mode = 'exam' AND passed = 1 THEN 1 ELSE 0 END) AS passed_exam_sessions
    FROM sessions
    WHERE status = 'completed'
  `);

  const domains = await db.all(`
    SELECT
      domain,
      COUNT(*) AS answered_count,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM session_answers
    GROUP BY domain
    ORDER BY domain ASC
  `);

  const totalAnswered = Number(totals.answered_questions || 0);
  const totalCorrect = Number(totals.correct_answers || 0);
  const examSessions = Number(totals.exam_sessions || 0);
  const passedExamSessions = Number(totals.passed_exam_sessions || 0);

  return res.json({
    totalSessions: Number(totals.total_sessions || 0),
    totalQuestionsConfigured: Number(totals.total_questions || 0),
    totalQuestionsAnswered: totalAnswered,
    correctAnswers: totalCorrect,
    overallAccuracyPercent: calculatePercent(totalCorrect, totalAnswered),
    examSessions,
    examPassRatePercent: calculatePercent(passedExamSessions, examSessions),
    domains: domains.map((row) => ({
      domain: row.domain,
      answeredCount: Number(row.answered_count),
      correctCount: Number(row.correct_count),
      accuracyPercent: calculatePercent(Number(row.correct_count), Number(row.answered_count))
    }))
  });
});

app.post("/api/reload", (_req, res) => {
  try {
    loadQuestions();
    return res.json({
      reloaded: true,
      questionCount: questions.length
    });
  } catch (error) {
    return res.status(500).json({
      reloaded: false,
      error: error instanceof Error ? error.message : "Unknown reload error"
    });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

async function start() {
  loadQuestions();
  await initializeDatabase();
  app.listen(port, () => {
    console.log(`Listening on ${port}`);
    console.log(`Database path: ${dbPath}`);
  });
}

start().catch((error) => {
  console.error("Application startup failed:", error);
  process.exit(1);
});
