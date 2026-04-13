import express from "express";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
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

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let questions = [];

function loadQuestions() {
  questions = readQuestionBank();
  console.log(`Loaded ${questions.length} questions.`);
}

loadQuestions();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    questionCount: questions.length,
    topics: [...new Set(questions.map((q) => q.topic))].sort((a, b) => a.localeCompare(b))
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

  const q = pickRandom(pool);
  return res.json({
    id: q.id,
    topic: q.topic,
    question: q.question,
    choices: q.choices
  });
});

app.post("/api/answer", (req, res) => {
  const { id, choiceIndex } = req.body ?? {};
  const q = questions.find((x) => x.id === id);

  if (!q) {
    return res.status(404).json({ error: "Unknown question id." });
  }

  if (typeof choiceIndex !== "number") {
    return res.status(400).json({ error: "choiceIndex must be a number." });
  }

  const correct = choiceIndex === q.correctIndex;

  return res.json({
    correct,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    refs: q.refs
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
app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
