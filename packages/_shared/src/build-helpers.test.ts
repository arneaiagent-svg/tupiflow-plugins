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
import { test } from "node:test";

import {
	assertFormFieldEnvVarsDeclared,
	assertNpmPackageNameValid,
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
