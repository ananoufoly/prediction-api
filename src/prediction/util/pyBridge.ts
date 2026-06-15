import { spawn } from 'child_process';
import path from 'path';

/**
 * Runs a Python fetcher script from src/prediction/python and streams its NDJSON
 * stdout back as parsed objects. Python stays STATELESS — it only fetches and
 * normalises; ALL database writes happen in TypeScript via Prisma (single write
 * path, single schema authority).
 *
 * Each Python script must print one JSON object per line to stdout. Diagnostics
 * go to stderr. Exit code 0 = success.
 */

// Runtime is CommonJS (tsconfig module=CommonJS), so __dirname is available.
// At runtime via tsx this file lives at src/prediction/util/, so python dir is ../python.
const PYTHON_DIR = path.resolve(__dirname, '..', 'python');

// Prefer the project venv (fananou/.venv); fall back to PATH python3.
// From src/prediction/util: ../../../../../.venv → fananou/.venv
const VENV_PYTHON = path.resolve(
  __dirname, '..', '..', '..', '..', '..', '.venv', 'bin', 'python3',
);

export interface PyResult {
  rows: unknown[];
  stderr: string;
}

export function runPython(
  script: string,
  args: string[] = [],
  opts?: { timeoutMs?: number; pythonBin?: string; input?: string },
): Promise<PyResult> {
  const scriptPath = path.join(PYTHON_DIR, script);
  const python = opts?.pythonBin ?? process.env['PREDICTION_PYTHON'] ?? VENV_PYTHON;
  const timeoutMs = opts?.timeoutMs ?? 5 * 60_000;

  return new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath, ...args], {
      cwd: PYTHON_DIR,
      // Force unbuffered stdout so NDJSON streams line-by-line.
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    // Optionally feed a payload (e.g. exported feature rows) via stdin.
    if (opts?.input != null) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }

    const rows: unknown[] = [];
    let stdoutBuf = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // Non-JSON line on stdout — treat as diagnostic.
          stderr += `[stdout-nonjson] ${line}\n`;
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn python (${python}): ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdoutBuf.trim()) {
        try { rows.push(JSON.parse(stdoutBuf.trim())); } catch { /* ignore trailing */ }
      }
      if (killed) {
        reject(new Error(`Python ${script} timed out after ${timeoutMs}ms\n${stderr.slice(-2000)}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Python ${script} exited ${code}\n${stderr.slice(-2000)}`));
        return;
      }
      resolve({ rows, stderr });
    });
  });
}
