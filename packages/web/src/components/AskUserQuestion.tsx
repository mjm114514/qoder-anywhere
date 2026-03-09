import { useState } from "react";
import type { PendingQuestion } from "../hooks/useSessionSocket";
import "./AskUserQuestion.css";

interface AskUserQuestionProps {
  pendingQuestion: PendingQuestion;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
}

export function AskUserQuestion({ pendingQuestion, onAnswer }: AskUserQuestionProps) {
  const { requestId, questions } = pendingQuestion;
  const [selections, setSelections] = useState<Record<string, string | Set<string>>>(() => {
    const init: Record<string, string | Set<string>> = {};
    for (const q of questions) {
      init[q.question] = q.multiSelect ? new Set<string>() : "";
    }
    return init;
  });
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  const handleSelect = (question: string, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      if (multiSelect) {
        const set = new Set(prev[question] as Set<string>);
        if (set.has(label)) set.delete(label);
        else set.add(label);
        return { ...prev, [question]: set };
      }
      return { ...prev, [question]: label };
    });
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const sel = selections[q.question];
      if (customInputs[q.question]) {
        answers[q.question] = customInputs[q.question];
      } else if (sel instanceof Set) {
        answers[q.question] = Array.from(sel).join(", ");
      } else {
        answers[q.question] = sel as string;
      }
    }
    onAnswer(requestId, answers);
  };

  const allAnswered = questions.every((q) => {
    if (customInputs[q.question]) return true;
    const sel = selections[q.question];
    if (sel instanceof Set) return sel.size > 0;
    return !!sel;
  });

  return (
    <div className="ask-question">
      <div className="ask-question-header">Claude is asking a question</div>
      {questions.map((q) => (
        <div key={q.question} className="ask-question-item">
          <div className="ask-question-badge">{q.header}</div>
          <div className="ask-question-text">{q.question}</div>
          <div className="ask-question-options">
            {q.options.map((opt) => {
              const sel = selections[q.question];
              const isSelected = sel instanceof Set
                ? sel.has(opt.label)
                : sel === opt.label;
              return (
                <button
                  key={opt.label}
                  className={`ask-question-option ${isSelected ? "ask-question-option--selected" : ""}`}
                  onClick={() => handleSelect(q.question, opt.label, q.multiSelect)}
                  title={opt.description}
                >
                  <span className="ask-question-option-label">{opt.label}</span>
                  <span className="ask-question-option-desc">{opt.description}</span>
                </button>
              );
            })}
          </div>
          <div className="ask-question-custom">
            <input
              type="text"
              placeholder="Or type a custom answer..."
              value={customInputs[q.question] ?? ""}
              onChange={(e) =>
                setCustomInputs((prev) => ({ ...prev, [q.question]: e.target.value }))
              }
            />
          </div>
        </div>
      ))}
      <button
        className="ask-question-submit"
        onClick={handleSubmit}
        disabled={!allAnswered}
      >
        Submit Answer
      </button>
    </div>
  );
}
