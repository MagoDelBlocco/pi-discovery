/**
 * Discovery Extension
 *
 * At session start, injects ONE compact, token-efficient project overview
 * into the agent's initial context. Status bar shows token count until
 * the first message arrives, then "discovery: fulfilled" (greyed).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { join, relative, dirname, extname } from "node:path";

// ── Config ────────────────────────────────────────────────────────

const TOKEN_BUDGET = parseInt(process.env.DISCOVERY_BUDGET || "1200", 10);
const PASS1_ENABLED = process.env.DISCOVERY_PASS1 !== "false";
const PASS2_ENABLED = process.env.DISCOVERY_PASS2 !== "false";
const EXTRA_IGNORE = (process.env.DISCOVERY_IGNORE || "")
	.split(",")
	.map((g) => g.trim())
	.filter(Boolean);

// ── Types ─────────────────────────────────────────────────────────

interface SymbolInfo {
	name: string;
	sig: string;
	exported: boolean;
}

interface FileSymbols {
	path: string;
	symbols: SymbolInfo[];
}

interface ProjectMeta {
	name: string;
	langs: string[];
	monorepo: boolean;
	branch: string;
	build: Record<string, string>;
	ci: string[];
	infra: string[];
	agentFiles: string[];
	workspaceGlobs: string[];
}

// ── Helpers ───────────────────────────────────────────────────────

function run(cmd: string, cwd: string): string {
	const r = spawnSync(cmd, {
		shell: true,
		cwd,
		encoding: "utf-8",
		timeout: 15_000,
	});
	return r.stdout ? r.stdout.trim() : "";
}

function read(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function isGitRepo(cwd: string): boolean {
	return !!run("git rev-parse --git-dir", cwd);
}

function tokenCount(text: string): number {
	return estimateTokens({
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	});
}

// ── File Inventory ────────────────────────────────────────────────

function listFiles(cwd: string): string[] {
	if (isGitRepo(cwd)) {
		const tracked = run("git ls-files", cwd);
		const untracked = run("git ls-files --others --exclude-standard", cwd);
		const all = `${tracked}\n${untracked}`
			.split("\n")
			.map((f: string) => f.trim())
			.filter(Boolean);
		return all;
	}

	const SKIP = new Set([
		"node_modules",
		"dist",
		"build",
		".venv",
		"target",
		"vendor",
		".git",
		...EXTRA_IGNORE,
	]);

	const result: string[] = [];
	function walk(dir: string) {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const e of entries) {
				if (e.isDirectory() && SKIP.has(e.name)) continue;
				const full = join(dir, e.name);
				if (e.isDirectory()) {
					walk(full);
				} else {
					result.push(relative(cwd, full));
				}
			}
		} catch {
			/* skip unreadable dirs */
		}
	}
	walk(cwd);
	return result;
}

// ── Pass 1: Metadata ──────────────────────────────────────────────

function countLangs(files: string[]): Record<string, number> {
	const exts: Record<string, number> = {};
	const LANG_MAP: Record<string, string> = {
		".ts": "ts",
		".tsx": "tsx",
		".js": "js",
		".jsx": "jsx",
		".py": "py",
		".rs": "rs",
		".go": "go",
		".java": "java",
		".rb": "rb",
		".php": "php",
		".cs": "cs",
		".cpp": "cpp",
		".c": "c",
		".h": "h",
		".hpp": "hpp",
		".swift": "swift",
		".kt": "kt",
		".scala": "scala",
		".r": "r",
		".R": "r",
		".sh": "sh",
		".bash": "sh",
		".zsh": "sh",
		".toml": "toml",
		".yaml": "yaml",
		".yml": "yaml",
		".json": "json",
		".md": "md",
		".html": "html",
		".css": "css",
		".sql": "sql",
		".graphql": "graphql",
		".proto": "proto",
	};
	for (const f of files) {
		const ext = extname(f).toLowerCase();
		const lang = LANG_MAP[ext] || ext;
		// Skip non-source extensions for language counting
		if ([".md", ".json", ".yaml", ".yml", ".toml", ".lock", ""].includes(lang))
			continue;
		exts[lang] = (exts[lang] || 0) + 1;
	}
	return exts;
}

function extractMeta(cwd: string, files: string[]): ProjectMeta {
	const meta: ProjectMeta = {
		name: "",
		langs: [],
		monorepo: false,
		branch: "",
		build: {},
		ci: [],
		infra: [],
		agentFiles: [],
		workspaceGlobs: [],
	};

	const fileSet = new Set(files);

	// Git branch
	if (isGitRepo(cwd)) {
		meta.branch = run("git branch --show-current", cwd) || "(detached)";
	}

	// Languages
	const langCounts = countLangs(files);
	const sorted = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
	meta.langs = sorted.slice(0, 3).map(([l]) => l);

	// package.json
	const pkgPath = join(cwd, "package.json");
	if (fileSet.has("package.json")) {
		const pkg = JSON.parse(read(pkgPath) || "{}");
		if (pkg.name) meta.name = pkg.name;
		if (pkg.scripts) {
			for (const [k, v] of Object.entries(pkg.scripts)) {
				if (typeof v === "string") meta.build[k] = v;
			}
		}
		if (pkg.workspaces) {
			meta.monorepo = true;
			meta.workspaceGlobs = Array.isArray(pkg.workspaces)
				? pkg.workspaces
				: pkg.workspaces.packages || [];
		}
	}

	// pnpm-workspace.yaml / turbo.json / nx.json / lerna.json
	for (const marker of [
		"pnpm-workspace.yaml",
		"turbo.json",
		"nx.json",
		"lerna.json",
	]) {
		if (fileSet.has(marker)) {
			meta.monorepo = true;
		}
	}

	// pyproject.toml
	if (fileSet.has("pyproject.toml")) {
		const content = read(join(cwd, "pyproject.toml"));
		if (content) {
			const nameM = content.match(/name\s*=\s*"([^"]+)"/);
			if (nameM && !meta.name) meta.name = nameM[1];
			// Extract [tool.setuptools.scripts] or [project.scripts]
			const scripts = content.match(/\[project\.scripts\][\s\S]*?(?=\[|$)/);
			if (scripts) {
				for (const m of scripts[0].matchAll(/(\w+)\s*=\s*"([^"]+)"/g)) {
					meta.build[m[1]] = m[2];
				}
			}
		}
	}

	// Cargo.toml
	if (fileSet.has("Cargo.toml")) {
		const content = read(join(cwd, "Cargo.toml"));
		if (content) {
			const nameM = content.match(/name\s*=\s*"([^"]+)"/);
			if (nameM && !meta.name) meta.name = nameM[1];
		}
	}

	// go.mod
	if (fileSet.has("go.mod")) {
		const content = read(join(cwd, "go.mod"));
		if (content) {
			const modM = content.match(/module\s+(.+)$/m);
			if (modM && !meta.name) meta.name = modM[1].trim();
		}
	}

	// Makefile targets
	if (fileSet.has("Makefile")) {
		const content = read(join(cwd, "Makefile"));
		if (content) {
			for (const m of content.matchAll(/^([a-zA-Z][\w-]*)\s*:/m)) {
				const target = m[1];
				if (!["all", "clean", "install"].includes(target)) {
					// Get the first recipe line
					const targetBlock = content.match(
						new RegExp(`${target}:\\s*\\n(\\s+.+?)`, "s"),
					);
					if (targetBlock) {
						meta.build[target] = targetBlock[1].trim().split("\n")[0].trim();
					} else {
						meta.build[target] = "";
					}
				}
			}
		}
	}

	// justfile
	if (fileSet.has("justfile")) {
		const content = read(join(cwd, "justfile"));
		if (content) {
			for (const m of content.matchAll(/^([a-zA-Z][\w-]*)\b/m)) {
				const recipe = m[1];
				if (!meta.build[recipe]) {
					meta.build[recipe] = "";
				}
			}
		}
	}

	// CI: .github/workflows/*.yml
	for (const f of files) {
		if (
			f.startsWith(".github/workflows/") &&
			(f.endsWith(".yml") || f.endsWith(".yaml"))
		) {
			const content = read(join(cwd, f));
			if (content) {
				// Extract run: commands
				for (const m of content.matchAll(/run:\s*(.+)$/gm)) {
					const cmd = m[1].trim().replace(/^["']|["']$/g, "");
					if (cmd && !meta.ci.includes(cmd)) meta.ci.push(cmd);
				}
			}
		}
		if (f === ".gitlab-ci.yml") {
			const content = read(join(cwd, f));
			if (content) {
				for (const m of content.matchAll(
					/- (?:sh -c )?["']?([^"'\n]+)["']?/gm,
				)) {
					const cmd = m[1].trim();
					if (cmd && cmd.length < 200 && !meta.ci.includes(cmd))
						meta.ci.push(cmd);
				}
			}
		}
	}

	// Infrastructure detection (presence-only)
	const INFRA_MARKERS = [
		"Dockerfile",
		"docker-compose.yml",
		"docker-compose.yaml",
		"k8s",
		"helm",
		"Chart.yaml",
		"tsconfig.json",
		".eslintrc",
		".eslintrc.json",
		".eslintrc.js",
		".prettierrc",
		"prettier.config.js",
		"ruff.toml",
		".ruff.toml",
		".nvmrc",
		".tool-versions",
		".node-version",
	];
	for (const marker of INFRA_MARKERS) {
		if (fileSet.has(marker)) {
			meta.infra.push(marker);
		} else {
			// Check for directory markers
			for (const f of files) {
				if (f.startsWith(marker + "/") && !meta.infra.includes(marker)) {
					meta.infra.push(marker);
					break;
				}
			}
		}
	}

	// Agent instruction files
	const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "PI.md"];
	for (const af of AGENT_FILES) {
		if (fileSet.has(af)) meta.agentFiles.push(af);
	}

	// Fallback project name
	if (!meta.name) {
		meta.name = basename(cwd);
	}

	return meta;
}

// ── Pass 2: Code Structure ────────────────────────────────────────

const SOURCE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".rb",
	".php",
	".cs",
	".cpp",
	".c",
	".h",
	".hpp",
	".swift",
	".kt",
]);

// Regex patterns for top-level symbol extraction per language
const SYM_PATTERNS: Record<string, RegExp[]> = {
	ts: [
		/export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s*<[^>]*>)?\s*(?:extends\s+[^{]+)?\s*\{/g,
		/export\s+(?:default\s+)?(?:abstract\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^:]+)?\s*(?:=\s*|\{)/g,
		/export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
		/export\s+(?:default\s+)?interface\s+(\w+)(?:\s*<[^>]*>)?\s*(?:extends\s+[^{]+)?\s*\{/g,
		/export\s+(?:default\s+)?type\s+(\w+)(?:\s*<[^>]*>)?\s*=/g,
		/export\s+(?:default\s+)?enum\s+(\w+)\s*\{/g,
		/export\s+(?:default\s+)?(?:const\s+)?namespace\s+(\w+)\s*\{/g,
		/(?:^|\n)(?:export\s+)?(?:async\s+)?(?:abstract\s+)?\s*(\w+)\s*\(.*?\)\s*(?::\s*[^{]+)?\s*\{/gm,
	],
	js: [
		/export\s+(?:default\s+)?(?:class)\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{/g,
		/export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g,
		/export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
		/module\.exports\s*=\s*(\w+)/g,
		/exports\.(\w+)\s*=/g,
	],
	py: [
		/^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)/gm,
		/^class\s+(\w+)(?:\s*\([^)]*\))?\s*:/gm,
	],
	rs: [
		/pub\s+(?:async\s+)?fn\s+(\w+)\s*<[^>]*>\s*\([^)]*\)/g,
		/pub\s+(?:async\s+)?fn\s+(\w+)\s*\([^)]*\)/g,
		/pub\s+struct\s+(\w+)\s*\{/g,
		/pub\s+enum\s+(\w+)\s*\{/g,
		/pub\s+trait\s+(\w+)\s*\{/g,
		/pub\s+type\s+(\w+)\s*=/g,
		/pub\s+const\s+(\w+):/g,
	],
	go: [
		/func\s+\(.*?\)\s+(\w+)\s*\([^)]*\)/g,
		/^func\s+(\w+)\s*\([^)]*\)/gm,
		/^type\s+(\w+)\s+struct/gm,
		/^type\s+(\w+)\s+interface/gm,
		/^type\s+(\w+)\s+/gm,
		/^var\s+(\w+)\s+/gm,
		/^const\s+(\w+)\s+/gm,
	],
	java: [
		/(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/g,
		/(?:public|private|protected)\s+(?:static\s+)?(?:abstract\s+)?(\w+)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\s*\{/g,
		/(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?\s*\w+\s+(\w+)\s*=/g,
	],
	rb: [
		/^def\s+(?:self\.)?(\w+[?!]?)/gm,
		/^class\s+(\w+)/gm,
		/^module\s+(\w+)/gm,
	],
};

function extractSymbolsFromFile(cwd: string, relPath: string): SymbolInfo[] {
	const ext = extname(relPath).toLowerCase();
	const lang = SYM_PATTERNS[ext.slice(1)] ? ext.slice(1) : null;
	if (!lang) return [];

	const content = read(join(cwd, relPath));
	if (!content) return [];

	const patterns = SYM_PATTERNS[lang];
	if (!patterns) return [];

	const seen = new Set<string>();
	const symbols: SymbolInfo[] = [];

	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		for (const match of content.matchAll(
			new RegExp(pattern.source, pattern.flags),
		)) {
			const name = match[1];
			if (!name || seen.has(name)) continue;
			seen.add(name);

			// Determine if exported
			const exported =
				match[0].includes("export") ||
				match[0].includes("pub") ||
				match[0].startsWith("def ") ||
				match[0].startsWith("class ") ||
				/^(?:public|protected)\s/.test(match[0]);

			// Build compact signature
			let sig = "";
			if (
				match[0].includes("class") ||
				match[0].includes("struct") ||
				match[0].includes("interface") ||
				match[0].includes("trait")
			) {
				sig = "{}";
			} else if (match[0].includes("enum")) {
				sig = "{}";
			} else if (match[0].includes("type") && !match[0].includes("function")) {
				sig = "=";
			} else {
				// Function: extract params briefly
				const paramMatch = match[0].match(/\(([^)]*)\)/);
				const retMatch = match[0].match(/:\s*([^{]+)\s*\{/);
				const params = paramMatch ? paramMatch[1].slice(0, 30).trim() : "";
				const ret = retMatch ? retMatch[1].trim().slice(0, 20) : "";
				sig = ret ? `(${params}):${ret}` : `(${params})`;
			}

			symbols.push({ name, sig, exported });
		}
	}

	return symbols;
}

function extractCodeStructure(cwd: string, files: string[]): FileSymbols[] {
	const sourceFiles = files.filter((f) =>
		SOURCE_EXTS.has(extname(f).toLowerCase()),
	);

	// Score files: prefer src/, lib/, fewer path segments, more symbols
	const scored: Array<{ file: string; score: number }> = [];

	for (const f of sourceFiles) {
		let score = 0;
		const parts = f.split("/");

		// Directory priority
		if (
			parts[0] === "src" ||
			parts[0] === "lib" ||
			parts[0] === "app" ||
			parts[0] === "pkg"
		)
			score += 10;
		if (
			parts[0] === "test" ||
			parts[0] === "tests" ||
			parts[0] === "__tests__" ||
			parts[0] === "spec"
		)
			score -= 5;
		if (parts[0] === "examples" || parts[0] === "demo") score -= 3;
		if (parts[0] === "scripts" || parts[0] === "bin") score -= 2;

		// Depth penalty (prefer top-level source files)
		score -= Math.max(0, parts.length - 3);

		// Index files get a boost
		if (
			parts[parts.length - 1]?.startsWith("index.") ||
			parts[parts.length - 1] === "main.go" ||
			parts[parts.length - 1] === "mod.rs"
		) {
			score += 5;
		}

		scored.push({ file: f, score });
	}

	scored.sort((a, b) => b.score - a.score);

	// Extract symbols from top files until we have enough
	const result: FileSymbols[] = [];
	const MAX_FILES = 50; // Hard cap on files to parse

	for (const { file } of scored.slice(0, MAX_FILES)) {
		const symbols = extractSymbolsFromFile(cwd, file);
		if (symbols.length > 0) {
			result.push({ path: file, symbols });
		}
	}

	// Rank symbols by: exported > non-exported, and by file score
	// Simple cross-file reference heuristic: count how many files import from the same directory
	const dirCounts = new Map<string, number>();
	for (const f of sourceFiles) {
		const d = dirname(f);
		dirCounts.set(d, (dirCounts.get(d) || 0) + 1);
	}

	// Sort symbols within file: exported first
	for (const fs of result) {
		fs.symbols.sort((a, b) => (b.exported ? 1 : 0) - (a.exported ? 1 : 0));
	}

	// Sort files by: exported symbol count (desc), then file score
	result.sort((a, b) => {
		const aExported = a.symbols.filter((s) => s.exported).length;
		const bExported = b.symbols.filter((s) => s.exported).length;
		return bExported - aExported;
	});

	return result;
}

// ── Format Overview ───────────────────────────────────────────────

function formatOverview(
	_cwd: string,
	meta: ProjectMeta,
	fileSymbols: FileSymbols[],
	_budget: number,
): { text: string; tokens: number } {
	const lines: string[] = [];

	// Header
	const langStr = meta.langs.join("+") || "?";
	const monoStr = meta.monorepo ? "y" : "n";
	lines.push(
		`proj: ${meta.name} | ${langStr} | monorepo:${monoStr} | branch:${meta.branch}`,
	);

	// Build commands
	if (Object.keys(meta.build).length > 0) {
		const buildEntries = Object.entries(meta.build);
		const buildStr = buildEntries
			.slice(0, 8)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		const buildLine =
			buildEntries.length > 8
				? `${buildStr} +${buildEntries.length - 8} more`
				: buildStr;
		lines.push(`build: ${buildLine}`);
	}

	// CI
	if (meta.ci.length > 0) {
		const ciStr = meta.ci.slice(0, 3).join(" | ");
		lines.push(`ci: ${ciStr}`);
	}

	// Infra
	if (meta.infra.length > 0) {
		lines.push(`infra: ${meta.infra.join(" ")}`);
	}

	// Agent files
	if (meta.agentFiles.length > 0) {
		lines.push(`agents: ${meta.agentFiles.join(" ")} (read on demand)`);
	}

	// Workspace globs
	if (meta.workspaceGlobs.length > 0) {
		lines.push(`workspaces: ${meta.workspaceGlobs.join(" ")}`);
	}

	// Code structure (Pass 2)
	if (fileSymbols.length > 0) {
		lines.push("api:");
		const MAX_DISPLAYED = 15;
		let displayed = 0;
		let totalFiles = fileSymbols.length;
		let totalSymbols = fileSymbols.reduce(
			(sum, fs) => sum + fs.symbols.length,
			0,
		);

		for (const fs of fileSymbols) {
			if (displayed >= MAX_DISPLAYED) break;
			const symStr = fs.symbols
				.slice(0, 8)
				.map((s) => `${s.name}${s.sig}`)
				.join("  ");
			const extra = fs.symbols.length > 8 ? ` +${fs.symbols.length - 8}` : "";
			lines.push(` ${fs.path}: ${symStr}${extra}`);
			displayed++;
			totalSymbols -= fs.symbols.length;
			totalFiles--;
		}

		if (totalFiles > 0) {
			lines.push(` +${totalFiles} files +${totalSymbols} symbols`);
		}
	}

	const text = lines.join("\n");
	const tokens = tokenCount(text);
	return { text, tokens };
}

// ── Truncate to Budget ────────────────────────────────────────────

function truncateToBudget(
	text: string,
	budget: number,
): { text: string; tokens: number } {
	const tokens = tokenCount(text);
	if (tokens <= budget) return { text, tokens };

	// Truncate from the end, line by line
	const lines = text.split("\n");
	const apiStart = lines.findIndex((l) => l === "api:");

	if (apiStart >= 0) {
		// Keep header, truncate api entries
		const header = lines.slice(0, apiStart + 1);
		const apiLines = lines.slice(apiStart + 1);

		// Binary search for the right number of api lines
		let lo = 0;
		let hi = apiLines.length;
		let best = 0;

		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const candidate = [
				...header,
				...apiLines.slice(0, mid),
				` +${apiLines.length - mid} files truncated`,
			].join("\n");
			if (tokenCount(candidate) <= budget) {
				best = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}

		const truncated = [
			...header,
			...apiLines.slice(0, best),
			` +${apiLines.length - best} files truncated`,
		].join("\n");
		return { text: truncated, tokens: tokenCount(truncated) };
	}

	// No api section, just truncate lines from end
	let lo = 0;
	let hi = lines.length;
	let best = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (tokenCount(lines.slice(0, mid).join("\n")) <= budget) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return {
		text: lines.slice(0, best).join("\n"),
		tokens: tokenCount(lines.slice(0, best).join("\n")),
	};
}

// ── Generate Overview ─────────────────────────────────────────────

function generateOverview(cwd: string): { text: string; tokens: number } {
	const files = listFiles(cwd);

	let meta: ProjectMeta = {
		name: "",
		langs: [],
		monorepo: false,
		branch: "",
		build: {},
		ci: [],
		infra: [],
		agentFiles: [],
		workspaceGlobs: [],
	};
	let fileSymbols: FileSymbols[] = [];

	if (PASS1_ENABLED) {
		meta = extractMeta(cwd, files);
	}

	if (PASS2_ENABLED) {
		fileSymbols = extractCodeStructure(cwd, files);
	}

	const formatted = formatOverview(cwd, meta, fileSymbols, TOKEN_BUDGET);
	return truncateToBudget(formatted.text, TOKEN_BUDGET);
}

// ── Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let overviewText = "";
	let overviewTokens = 0;
	let injected = false;
	let sessionHasMessages = false;

	pi.on("session_start", async (_event, ctx) => {
		injected = false;
		sessionHasMessages = false;

		// Check if session already has user messages (resume/fork)
		const entries = ctx.sessionManager.getEntries();
		const hasUserMessages = entries.some(
			(e) => e.type === "message" && e.message?.role === "user",
		);
		if (hasUserMessages) {
			sessionHasMessages = true;
		}

		// Generate overview
		try {
			const result = generateOverview(ctx.cwd);
			overviewText = result.text;
			overviewTokens = result.tokens;
		} catch (err) {
			console.error("[discovery] Failed to generate overview:", err);
			overviewText = "";
			overviewTokens = 0;
			return;
		}

		// Update status bar
		updateStatusBar(ctx);

		// If session already has messages, mark as fulfilled immediately
		if (sessionHasMessages) {
			injected = true;
		}
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!overviewText || injected) return;

		injected = true;

		return {
			message: {
				customType: "discovery",
				content: overviewText,
				display: false,
			},
		};
	});

	pi.on("message_end", async (_event, ctx) => {
		if (!sessionHasMessages) {
			sessionHasMessages = true;
			updateStatusBar(ctx);
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateStatusBar(ctx);
	});

	function updateStatusBar(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		const theme = ctx.ui.theme;
		if (!sessionHasMessages && overviewTokens > 0) {
			ctx.ui.setStatus(
				"discovery",
				`│ ${theme.bg("customMessageBg", theme.fg("dim", `discovery: ${overviewTokens}t`))}`,
			);
		} else if (injected || sessionHasMessages) {
			ctx.ui.setStatus(
				"discovery",
				`│ ${theme.bg("customMessageBg", theme.fg("dim", "discovery: fulfilled"))}`,
			);
		}
	}

	// ── /discovery command ──────────────────────────────────────────
	pi.registerCommand("discovery", {
		description: "Show or regenerate the project discovery overview",
		handler: async (args: string | undefined, ctx) => {
			if (args?.trim() === "regen") {
				try {
					const result = generateOverview(ctx.cwd);
					overviewText = result.text;
					overviewTokens = result.tokens;
					injected = false; // Force re-injection on next turn
					ctx.ui.notify(
						`Overview regenerated: ${overviewTokens} tokens`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(`Failed to regenerate: ${err}`, "error");
					return;
				}
			}

			const lines = [
				`Discovery Overview (${overviewTokens} tokens, budget: ${TOKEN_BUDGET})`,
				`Pass1: ${PASS1_ENABLED ? "on" : "off"} | Pass2: ${PASS2_ENABLED ? "on" : "off"}`,
				`Injected: ${injected ? "yes" : "no"}`,
				"",
				overviewText || "(no overview generated)",
			];
			ctx.ui.setWidget("discovery", lines);
		},
	});
}
