import { dragConfig } from "./config.js";
import { startDragGroupController } from "./runtime.js";
// Independent async entry: starts without loading React or the manager UI.
void startDragGroupController({ ...dragConfig, manager: true }).catch(console.error);
