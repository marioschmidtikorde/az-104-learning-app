import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const questions = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf-8"));

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/question", (req, res) => {
  const topic = (req.query.topic || "").toString().trim();
  const pool = topic ? questions.filter(q => q.topic === topic) : questions;
  if (!pool.length) return res.status(404).json({ error: "No questions for this topic." });

  const q = pickRandom(pool);
  res.json({ id: q.id, topic: q.topic, question: q.question, choices: q.choices });
});

app.post("/api/answer", (req, res) => {
  const { id, choiceIndex } = req.body ?? {};
  const q = questions.find(x => x.id === id);
  if (!q) return res.status(404).json({ error: "Unknown question id." });
  if (typeof choiceIndex !== "number") return res.status(400).json({ error: "choiceIndex must be a number." });

  const correct = choiceIndex === q.correctIndex;
  res.json({ correct, correctIndex: q.correctIndex, explanation: q.explanation, refs: q.refs ?? [] });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
