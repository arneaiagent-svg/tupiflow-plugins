// Runtime tests for build-helpers.ts.
//
// Anchored next to the Phase B capability/connection coherence check, these
// tests cover:
//   - Convention X: every formField.envVar MUST appear in
//     manifest.credentials[].key (`assertFormFieldEnvVarsDeclared`).
//   - npm package-name format validation for `manifest.requiredNpmDeps`
//     (`assertNpmPackageNameValid`). The closed `ALLOWED_NPM_DEPS` allowlist
//     was removed in 0.15.0 — trust now sits at the registry publisher
//     layer; the shim only enforces npm's package-name shape (anti-injection).
//
// Both exported predicates are the unit-test seam — buildPlugin() itself is
// too heavy to spin up under node:test (esbuild + tar + tmp fs), and the
// predicates are pure on their inputs so direct calls give full coverage.
//
// Runner: `node --test --experimental-strip-types src/build-helpers.test.ts`
// (the package "test" script invokes this on just this file because
// `host-api-types.test.ts` is a type-only fixture that intentionally trips
// strip-only mode via parameter properties from host-api-types.ts).

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
	assertFormFieldEnvVarsDeclared,
	assertNpmPackageNameValid,
	buildPlugin,
} from "./build-helpers.ts";
import type {
	ManifestCredential,
	ManifestFormField,
} from "./manifest-types.ts";

test("assertFormFieldEnvVarsDeclared: positive — envVar matches a declared credential key", () => {
	const formFields: ManifestFormField[] = [
		{
			id: "botToken",
			label: "Bot token",
			type: "password",
			configKey: "botToken",
			envVar: "TELEGRAM_BOT_API_KEY",
		},
	];
	const credentials: ManifestCredential[] = [
		{
			key: "TELEGRAM_BOT_API_KEY",
			label: "Telegram bot API key",
			type: "password",
		},
	];
	assert.doesNotThrow(() =>
		assertFormFieldEnvVarsDeclared(formFields, credentials),
	);
});

test("assertFormFieldEnvVarsDeclared: negative — envVar without a matching credential throws", () => {
	const formFields: ManifestFormField[] = [
		{
			id: "botToken",
			label: "Bot token",
			type: "password",
			configKey: "botToken",
			envVar: "TELEGRAM_BOT_API_KEY",
		},
	];
	const credentials: ManifestCredential[] = [];
	assert.throws(
		() => assertFormFieldEnvVarsDeclared(formFields, credentials),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(
				err.message,
				/formField "botToken" declares envVar "TELEGRAM_BOT_API_KEY" but no manifest credential declares that key/,
			);
			return true;
		},
	);
});

test("assertNpmPackageNameValid: positive — accepts arbitrary well-formed names", () => {
	// Plain, scoped, with dot/underscore/hyphen, numbers, single-char etc.
	const valid = [
		"lodash",
		"jsdom",
		"@mozilla/readability",
		"@chat-adapter/telegram",
		"@scope/pkg-name",
		"@scope/pkg.name",
		"@scope/pkg_name",
		"pdf-parse",
		"a",
		"a1",
		"@a/b",
		"package.name",
	];
	for (const name of valid) {
		assert.doesNotThrow(
			() => assertNpmPackageNameValid(name),
			`expected "${name}" to be accepted`,
		);
	}
});

test("assertNpmPackageNameValid: negative — rejects malformed names", () => {
	// Each case includes a fragment we expect in the error message so we
	// catch regression silently swapping in a too-permissive regex.
	const cases: Array<[string, RegExp]> = [
		["", /non-empty string/],
		[".hidden", /not a valid npm package name/],
		["_underscore", /not a valid npm package name/],
		["UPPER", /not a valid npm package name/],
		["with space", /not a valid npm package name/],
		["bad;name", /not a valid npm package name/],
		["bad|name", /not a valid npm package name/],
		["bad/name", /not a valid npm package name/], // unscoped slash
		["@/missing-scope", /not a valid npm package name/],
		["@scope/", /not a valid npm package name/],
		["@scope/.hidden", /not a valid npm package name/],
		["@SCOPE/pkg", /not a valid npm package name/],
		["a".repeat(215), /exceeds npm package-name limit/],
	];
	for (const [name, re] of cases) {
		assert.throws(
			() => assertNpmPackageNameValid(name),
			(err) => {
				assert.ok(err instanceof Error, `"${name}" should throw Error`);
				assert.match(err.message, re, `"${name}" error mismatch`);
				return true;
			},
		);
	}
});

test("assertNpmPackageNameValid: negative — non-string input throws", () => {
	// Defensive: TS callers can't reach here, but Object.entries on a JS
	// caller's record could yield a non-string key in pathological cases.
	assert.throws(
		() => assertNpmPackageNameValid(undefined as unknown as string),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /non-empty string/);
			return true;
		},
	);
});

// --- buildPlugin end-to-end: frontend pipeline tests -----------------------
//
// These three tests are NOT pure predicates — they exercise the full
// buildPlugin() pipeline (esbuild + tar + tmp fs) against a synthetic
// plugin fixture. Justified because the frontend bundle participates in the
// signing root (HANDOFF_REPRODUCIBLE_BUNDLE_TAR.md): we cannot assert
// byte-stability or React externalization without running the real build.

const PLUGIN_TOML_FIXTURE = [
	"[identity]",
	'name        = "shim-frontend-test"',
	'type        = "shim-frontend-test"',
	'version     = "0.0.1"',
	'publisher   = "tupiflow"',
	'description = "Frontend-pipeline test fixture for @tupiflow-plugins/shared build-helpers."',
	"",
	"[runtime]",
	'min_tupiflow_version = "0.0.0"',
	"",
	"capabilities = []",
	"",
].join("\n");

const SRC_INDEX_FIXTURE =
	"export const placeholder = 'shim-frontend-test entrypoint';\n";

// Component imports across multiple BLESSED_BROWSER_MODULES so the
// externalization assertion exercises more than just react.
const FRONTEND_DASHBOARD_FIXTURE = [
	"import { useState } from 'react';",
	"import { Database } from 'lucide-react';",
	"export function Dashboard() {",
	"  const [n, setN] = useState(0);",
	"  return (",
	"    <button type=\"button\" onClick={() => setN(n + 1)}>",
	"      <Database /> Count: {n}",
	"    </button>",
	"  );",
	"}",
	"",
].join("\n");

async function makeFrontendFixture(): Promise<{ root: string; distDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "tupiflow-shim-frontend-"));
	await writeFile(resolve(root, "plugin.toml"), PLUGIN_TOML_FIXTURE);
	await mkdir(resolve(root, "src"), { recursive: true });
	await writeFile(resolve(root, "src", "index.ts"), SRC_INDEX_FIXTURE);
	await mkdir(resolve(root, "frontend"), { recursive: true });
	await writeFile(
		resolve(root, "frontend", "dashboard.tsx"),
		FRONTEND_DASHBOARD_FIXTURE,
	);
	return { root, distDir: resolve(root, "dist") };
}

test("buildPlugin compiles declared frontendRoutes[].bundleEntry to dist/<entry>", async (t) => {
	const { root, distDir } = await makeFrontendFixture();
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const frontendRoutes = [
		{
			path: "/dashboard",
			label: "Dashboard",
			componentExport: "Dashboard",
			bundleEntry: "frontend/dashboard.mjs",
		},
	];
	const result = await buildPlugin({
		root,
		srcEntry: "src/index.ts",
		distDir,
		actions: [],
		frontendRoutes,
	});

	// Compiled bundle landed at the declared path.
	const stats = await stat(resolve(distDir, "frontend/dashboard.mjs"));
	assert.ok(stats.size > 0, "dist/frontend/dashboard.mjs must be non-empty");

	// Manifest carried the declared array verbatim.
	assert.deepEqual(result.manifest.frontendRoutes, frontendRoutes);

	// Tarball materialized at the standard path.
	const tgzStats = await stat(result.bundleTgzPath);
	assert.ok(tgzStats.size > 0, "bundle.tgz must exist and be non-empty");
});

test("frontend bundle externalizes BLESSED_BROWSER_MODULES (react, lucide-react)", async (t) => {
	const { root, distDir } = await makeFrontendFixture();
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	await buildPlugin({
		root,
		srcEntry: "src/index.ts",
		distDir,
		actions: [],
		frontendRoutes: [
			{
				path: "/dashboard",
				label: "Dashboard",
				componentExport: "Dashboard",
				bundleEntry: "frontend/dashboard.mjs",
			},
		],
	});

	const bytes = await readFile(
		resolve(distDir, "frontend/dashboard.mjs"),
		"utf8",
	);

	// esbuild ESM emits `from "react"` / `from "react/jsx-runtime"` /
	// `from "lucide-react"` for externals. At least the react import MUST
	// appear; lucide-react MUST appear because the fixture imports Database.
	assert.match(
		bytes,
		/from\s*["']react["']/,
		"frontend bundle must externally import react",
	);
	assert.match(
		bytes,
		/from\s*["']react\/jsx-runtime["']/,
		"frontend bundle must externally import react/jsx-runtime (jsx:automatic)",
	);
	assert.match(
		bytes,
		/from\s*["']lucide-react["']/,
		"frontend bundle must externally import lucide-react",
	);

	// React's source contains `Symbol.for("react.` for element/fragment
	// sentinels (stable across React 18/19 minors). If React got inlined,
	// the literal string appears in the bundle. Externalized -> absent.
	assert.doesNotMatch(
		bytes,
		/Symbol\.for\(["']react\./,
		"frontend bundle must NOT inline React source (Symbol.for sentinel absent)",
	);

	// Defense-in-depth: a frontend bundle that externalizes everything
	// should be tiny (< 4 KB). Inlining React alone is > 100 KB. This is a
	// coarse guard against silent regressions in the external list.
	const sizeBytes = Buffer.byteLength(bytes, "utf8");
	assert.ok(
		sizeBytes < 4096,
		`frontend bundle is ${sizeBytes} bytes; expected < 4096 with all externals (React likely inlined)`,
	);
});

test("buildPlugin produces byte-stable dist/frontend/<entry>.mjs + bundle.tgz across two builds", async (t) => {
	const { root, distDir } = await makeFrontendFixture();
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const opts = {
		root,
		srcEntry: "src/index.ts",
		distDir,
		actions: [],
		frontendRoutes: [
			{
				path: "/dashboard",
				label: "Dashboard",
				componentExport: "Dashboard",
				bundleEntry: "frontend/dashboard.mjs",
			},
		],
	};

	const result1 = await buildPlugin(opts);
	const frontendSha1 = createHash("sha256")
		.update(await readFile(resolve(distDir, "frontend/dashboard.mjs")))
		.digest("hex");
	const tgzSha1 = createHash("sha256")
		.update(await readFile(result1.bundleTgzPath))
		.digest("hex");

	// buildPlugin rm's distDir at the top of runBuildOnce; rebuild from a
	// clean slate to catch any in-place mutation that would otherwise hide
	// determinism bugs.
	const result2 = await buildPlugin(opts);
	const frontendSha2 = createHash("sha256")
		.update(await readFile(resolve(distDir, "frontend/dashboard.mjs")))
		.digest("hex");
	const tgzSha2 = createHash("sha256")
		.update(await readFile(result2.bundleTgzPath))
		.digest("hex");

	assert.equal(
		frontendSha1,
		frontendSha2,
		"frontend bundle must be byte-stable across builds",
	);
	assert.equal(
		tgzSha1,
		tgzSha2,
		"bundle.tgz must be byte-stable with frontend entries included",
	);
});
