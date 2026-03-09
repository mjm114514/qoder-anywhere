export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string; // Present-continuous text shown when in_progress (e.g. "Running tests")
}
