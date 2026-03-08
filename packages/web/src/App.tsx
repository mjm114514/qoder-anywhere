import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import "./App.css";

export interface SelectedProject {
  cwd: string;
  name: string;
}

export default function App() {
  const [selectedProject, setSelectedProject] =
    useState<SelectedProject | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [showNewSession, setShowNewSession] = useState(false);

  const handleSelectProject = (project: SelectedProject) => {
    setSelectedProject(project);
    setSelectedSessionId(null);
    setShowNewSession(false);
  };

  const handleSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setShowNewSession(false);
  };

  const handleNewSession = () => {
    setSelectedSessionId(null);
    setShowNewSession(true);
  };

  const handleSessionCreated = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setShowNewSession(false);
  };

  return (
    <div className="app">
      <Sidebar
        selectedProject={selectedProject}
        selectedSessionId={selectedSessionId}
        onSelectProject={handleSelectProject}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
      />
      <ChatArea
        selectedProject={selectedProject}
        selectedSessionId={selectedSessionId}
        showNewSession={showNewSession}
        onSessionCreated={handleSessionCreated}
      />
    </div>
  );
}
