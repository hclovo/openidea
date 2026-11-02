/** Python web frameworks run from their application file: FastAPI's uvicorn target, Flask's app (pure). */

/** uvicorn's module for an application file relative to the working directory: `app/main.py` → `app.main`. */
export const appModule = (file: string) =>
  file
    .trim()
    .replace(/^\.[\\/]/, "")
    .replace(/\.py$/, "")
    .replace(/[\\/]/g, ".");

/** The `FastAPI()` object a module defines at top level (`app = FastAPI(…)`), unless it starts uvicorn itself. */
export function fastApiApp(content: string | undefined): string | null {
  if (!content || /\buvicorn\.run\(/.test(content)) return null;
  return /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?:fastapi\.)?FastAPI\(/m.exec(content)?.[1] ?? null;
}

/** Whether a module defines a Flask application at top level (`app = Flask(__name__)`), unless it starts the server itself. */
export function isFlaskApp(content: string | undefined): boolean {
  if (!content || /\.run\(/.test(content)) return false;
  return /^[A-Za-z_]\w*\s*(?::[^=\n]+)?=\s*(?:flask\.)?Flask\(/m.test(content);
}
