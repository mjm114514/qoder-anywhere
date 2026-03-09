import { useState } from "react";
import type { TodoItem } from "@lgtm-anywhere/shared";
import "./TodoPanel.css";

interface TodoPanelProps {
  todos: TodoItem[];
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const [open, setOpen] = useState(false);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;

  return (
    <div className={`todo-float ${open ? "todo-float--open" : ""}`}>
      <button
        className="todo-float-tab"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide tasks" : "Show tasks"}
      >
        <span className="todo-float-tab-icon">{open ? "\u276f" : "\u276e"}</span>
        {!open && (
          <span className="todo-float-tab-badge">
            {completed}/{todos.length}
          </span>
        )}
      </button>
      <aside className="todo-panel">
        <div className="todo-panel-header">
          <span className="todo-panel-title">Tasks</span>
          <span className="todo-panel-count">
            {completed}/{todos.length}
          </span>
        </div>
        <ul className="todo-panel-list">
          {todos.map((todo, i) => (
            <li key={i} className={`todo-item todo-item--${todo.status}`}>
              <span className="todo-item-check" />
              <span className="todo-item-text">
                {todo.status === "in_progress" && todo.activeForm
                  ? todo.activeForm
                  : todo.content}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
