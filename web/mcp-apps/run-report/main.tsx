import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import "../run-report.css";
import { RunReportApp } from "./app";

const root = document.getElementById("root");
if (!root) {
  throw new Error("run-report root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <RunReportApp />
    </TooltipProvider>
  </StrictMode>
);
