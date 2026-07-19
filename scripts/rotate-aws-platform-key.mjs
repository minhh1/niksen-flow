#!/usr/bin/env node
// scripts/rotate-aws-platform-key.mjs
// Rotates the AWS access key used by lib/vmProviders/platformCredentials.ts
// for platform-billed Windows virtual computers (see lib/vmProviders/aws.ts).
// Run locally/via a scheduled bridge routine -- never in the deployed app
// itself, which is why @aws-sdk/client-iam is a devDependency, not a
// dependency. Requires:
//   - `vercel` CLI already authenticated and this repo linked (`vercel link`)
//     to the niksen-flow project -- reuses that session, doesn't manage its
//     own Vercel auth.
//   - A JSON credentials file at ~/.niksen-flow-rotator-credentials.json:
//     { "accessKeyId": "...", "secretAccessKey": "...", "region": "us-east-1" }
//     for the *separate*, narrowly-scoped "niksen-flow-key-rotator" IAM user
//     (iam:CreateAccessKey/DeleteAccessKey/ListAccessKeys/UpdateAccessKey on
//     just the niksen-flow-vm-provisioning user's ARN) -- deliberately not
//     the same credential the running app uses, so the app itself never has
//     IAM self-modify rights.
//
// Safety property: the old key is only deactivated/deleted AFTER the new
// deployment is confirmed live and healthy. Any failure before that point
// leaves the old key active and untouched, so a partial run never leaves
// platform-billed VM provisioning without a working credential.
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  IAMClient,
  ListAccessKeysCommand,
  CreateAccessKeyCommand,
  UpdateAccessKeyCommand,
  DeleteAccessKeyCommand,
} from "@aws-sdk/client-iam";

const IAM_USER_NAME = "niksen-flow-vm-provisioning";
const CREDENTIALS_PATH = join(homedir(), ".niksen-flow-rotator-credentials.json");
const MARKER_PATH = join(import.meta.dirname, ".last-aws-key-rotation.json");

function log(msg) {
  console.log(`[rotate-aws-platform-key] ${msg}`);
}

function loadRotatorCredentials() {
  let raw;
  try {
    raw = readFileSync(CREDENTIALS_PATH, "utf8");
  } catch {
    throw new Error(`Missing rotator credentials file at ${CREDENTIALS_PATH}`);
  }
  const parsed = JSON.parse(raw);
  if (!parsed.accessKeyId || !parsed.secretAccessKey || !parsed.region) {
    throw new Error(`${CREDENTIALS_PATH} must have accessKeyId, secretAccessKey, and region`);
  }
  return parsed;
}

function run(cmd, args, options = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { encoding: "utf8", ...options });
}

async function main() {
  const rotator = loadRotatorCredentials();
  const iam = new IAMClient({
    region: rotator.region,
    credentials: { accessKeyId: rotator.accessKeyId, secretAccessKey: rotator.secretAccessKey },
  });

  log(`Listing existing access keys for ${IAM_USER_NAME}...`);
  const { AccessKeyMetadata } = await iam.send(new ListAccessKeysCommand({ UserName: IAM_USER_NAME }));
  const existingKeys = AccessKeyMetadata ?? [];
  if (existingKeys.length >= 2) {
    throw new Error(
      `${IAM_USER_NAME} already has 2 access keys (AWS's max) -- clean up manually in the IAM console before rotating again.`
    );
  }
  const oldKeyId = existingKeys[0]?.AccessKeyId ?? null;
  log(oldKeyId ? `Current key: ${oldKeyId}` : "No existing key found (first-time setup).");

  log("Creating new access key...");
  const created = await iam.send(new CreateAccessKeyCommand({ UserName: IAM_USER_NAME }));
  const newKey = created.AccessKey;
  if (!newKey?.AccessKeyId || !newKey.SecretAccessKey) throw new Error("AWS did not return a new access key.");
  log(`New key created: ${newKey.AccessKeyId}`);

  try {
    for (const env of ["production", "preview"]) {
      for (const [name, value] of [
        ["AWS_PLATFORM_ACCESS_KEY_ID", newKey.AccessKeyId],
        ["AWS_PLATFORM_SECRET_ACCESS_KEY", newKey.SecretAccessKey],
      ]) {
        try {
          run("vercel", ["env", "rm", name, env, "--yes"]);
        } catch {
          // Fine if it didn't exist yet (first-time setup).
        }
        run("vercel", ["env", "add", name, env], { input: value });
      }
    }

    log("Triggering a fresh deployment so the new key actually takes effect...");
    run("git", ["commit", "--allow-empty", "-m", "Rotate AWS platform access key (automated)"]);
    run("git", ["push", "origin", "main"]);

    log("Waiting for the new deployment to go live...");
    let ready = false;
    for (let attempt = 0; attempt < 20 && !ready; attempt++) {
      await new Promise((r) => setTimeout(r, 15000));
      const out = run("vercel", ["ls", "--scope", "niksen-flow"]);
      // The most recent deployment is the first data row containing a
      // deployment URL -- check that specific row for "Ready" rather than
      // assuming a fixed line number, which shifts if vercel's output
      // format changes.
      const mostRecentRow = out.split("\n").find((line) => line.includes("niksen-flow-") && line.includes("vercel.app"));
      ready = !!mostRecentRow && /Ready/.test(mostRecentRow);
    }
    if (!ready) throw new Error("Timed out waiting for the new deployment to become Ready -- not deleting the old key.");
    log("New deployment is live.");
  } catch (err) {
    log(`FAILED before confirming the new key works -- leaving old key ${oldKeyId} active untouched.`);
    throw err;
  }

  if (oldKeyId) {
    log(`Deactivating and deleting old key ${oldKeyId}...`);
    await iam.send(new UpdateAccessKeyCommand({ UserName: IAM_USER_NAME, AccessKeyId: oldKeyId, Status: "Inactive" }));
    await iam.send(new DeleteAccessKeyCommand({ UserName: IAM_USER_NAME, AccessKeyId: oldKeyId }));
  }

  writeFileSync(MARKER_PATH, JSON.stringify({ rotatedAt: new Date().toISOString(), newKeyId: newKey.AccessKeyId }, null, 2));
  run("git", ["add", MARKER_PATH]);
  run("git", ["commit", "-m", "Record AWS platform access key rotation timestamp"]);
  run("git", ["push", "origin", "main"]);

  log("Rotation complete.");
}

main().catch((err) => {
  console.error(`[rotate-aws-platform-key] ERROR: ${err.message}`);
  process.exit(1);
});
