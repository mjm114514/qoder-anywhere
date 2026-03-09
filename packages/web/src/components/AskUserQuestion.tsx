import { useState, useEffect } from "react";
import type { PendingQuestion } from "../hooks/useSessionSocket";
import "./AskUserQuestion.css";

interface AskUserQuestionProps {
  pendingQuestion: PendingQuestion;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
}

export function AskUserQuestion({ pendingQuestion, onAnswer }: AskUserQuestionProps) {
  const { requestId, questions } = pendingQuestion;
  const [activeTab, setActiveTab] = useState(0);
  const [selections, setSelections] = useState<Record<string, string | Set<string>>>(() => {
    const init: Record<string, string | Set<string>> = {};
    for (const q of questions) {
      init[q.question] = q.multiSelect ? new Set<string>() : "";
    }
    return init;
  });
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  // Reset active tab when pendingQuestion changes
  useEffect(() => {
    setActiveTab(0);
  }, [requestId]);

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

    // Auto-advance to next unanswered question on single-select
    if (!multiSelect && activeTab < questions.length - 1) {
      setTimeout(() => setActiveTab(activeTab + 1), 200);
    }
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

  const isQuestionAnswered = (q: typeof questions[number]) => {
    if (customInputs[q.question]) return true;
    const sel = selections[q.question];
    if (sel instanceof Set) return sel.size > 0;
    return !!sel;
  };

  const currentQuestion = questions[activeTab];

  return (
    <div className="ask-question">
      <div className="ask-question-header">Claude is asking a question</div>

      {questions.length > 1 && (
        <div className="ask-question-tabs">
          {questions.map((q, i) => (
            <button
              key={q.question}
              className={`ask-question-tab ${i === activeTab ? "ask-question-tab--active" : ""} ${isQuestionAnswered(q) ? "ask-question-tab--answered" : ""}`}
              onClick={() => setActiveTab(i)}
            >
              <span className="ask-question-tab-index">{i + 1}</span>
              {q.header}
              {isQuestionAnswered(q) && <span className="ask-question-tab-check">&#10003;</span>}
            </button>
          ))}
        </div>
      )}

      {currentQuestion && (
        <div className="ask-question-item">
          {questions.length <= 1 && (
            <div className="ask-question-badge">{currentQuestion.header}</div>
          )}
          <div className="ask-question-text">
            {currentQuestion.question}
            {currentQuestion.multiSelect && <span className="ask-question-multi-hint"> (multi-select)</span>}
          </div>
          <div className="ask-question-options">
            {currentQuestion.options.map((opt) => {
              const sel = selections[currentQuestion.question];
              const isSelected = sel instanceof Set
                ? sel.has(opt.label)
                : sel === opt.label;
              return (
                <button
                  key={opt.label}
                  className={`ask-question-option ${isSelected ? "ask-question-option--selected" : ""}`}
                  onClick={() => handleSelect(currentQuestion.question, opt.label, currentQuestion.multiSelect)}
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
              value={customInputs[currentQuestion.question] ?? ""}
              onChange={(e) =>
                setCustomInputs((prev) => ({ ...prev, [currentQuestion.question]: e.target.value }))
              }
            />
          </div>
        </div>
      )}

      <div className="ask-question-footer">
        {questions.length > 1 && (
          <span className="ask-question-progress">
            {questions.filter(isQuestionAnswered).length} / {questions.length} answered
          </span>
        )}
        <button
          className="ask-question-submit"
          onClick={handleSubmit}
          disabled={!allAnswered}
        >
          Submit Answer
        </button>
      </div>
    </div>
  );
}
