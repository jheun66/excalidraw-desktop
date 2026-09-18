// Must come first: it has to run before browser-fs-access decides which
// implementation to use. See src/fsa-shim.ts.
import "./fsa-shim";
// Must also precede the Excalidraw bundle: it reads the asset path when it
// registers its fonts. See src/asset-path.ts.
import "./asset-path";

import React from "react";
import { createRoot } from "react-dom/client";

import "@excalidraw/excalidraw/index.css";
import "./styles.css";

import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
