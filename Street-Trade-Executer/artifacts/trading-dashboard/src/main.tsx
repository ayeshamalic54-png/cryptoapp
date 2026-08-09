import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initApiConfig } from "@/lib/api";

initApiConfig();

createRoot(document.getElementById("root")!).render(<App />);
