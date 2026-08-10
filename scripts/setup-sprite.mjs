import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VENV_DIR = join(ROOT, ".venv");
const REQUIREMENTS = join(ROOT, "sprite_engine", "requirements.txt");
const VENV_PYTHON = process.platform === "win32"
  ? join(VENV_DIR, "Scripts", "python.exe")
  : join(VENV_DIR, "bin", "python");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function pythonVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = `${result.stdout}${result.stderr}`.match(/Python\s+(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 3 && minor >= 10 && minor <= 13 ? { command, major, minor } : null;
}

const requested = process.env.SPRITE_PYTHON?.trim();
const candidates = requested
  ? [requested]
  : ["python3.13", "python3.12", "python3.11", "python3.10", "python3"];
const selected = candidates.map(pythonVersion).find(Boolean);

if (!selected) {
  console.error("Python 3.10-3.13을 찾지 못했습니다. SPRITE_PYTHON=/path/to/python을 지정해 다시 실행해 주세요.");
  process.exit(1);
}

console.log(`Sprite engine setup: Python ${selected.major}.${selected.minor} (${selected.command})`);
if (!existsSync(VENV_PYTHON)) {
  console.log("1/3 프로젝트 전용 .venv를 만듭니다.");
  run(selected.command, ["-m", "venv", VENV_DIR]);
} else {
  console.log("1/3 기존 프로젝트 .venv를 사용합니다.");
}

console.log("2/3 pip를 준비합니다.");
run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip"]);

console.log("3/3 BiRefNet와 스프라이트 의존성을 설치합니다.");
run(VENV_PYTHON, ["-m", "pip", "install", "-r", REQUIREMENTS]);

console.log("설치 완료. pnpm start 후 GUI에서 스프라이트 엔진 상태를 확인하세요.");
