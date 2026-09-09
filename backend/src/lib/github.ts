import fs from "node:fs";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import dotenv from "dotenv";
dotenv.config();

const APP_ID = Number(process.env.GITHUB_APP_ID);
const PRIVATE_KEY_PATH =
  process.env.GITHUB_APP_PRIVATE_KEY_PATH || "./keys/github_app.pem";

let privateKey = "";
if (fs.existsSync(path.resolve(PRIVATE_KEY_PATH))) {
  privateKey = fs.readFileSync(path.resolve(PRIVATE_KEY_PATH), "utf8");
}

// create an Octokit authenticated as the app (JWT-based)
export function getAppOctokit() {
  if (!privateKey) throw new Error('GitHub App private key not found');
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: APP_ID,
      privateKey,
    },
  });
}

// create octokit for an installation (installation token)
export async function getInstallationOctokit(installationId: number | string) {
  if (!privateKey) throw new Error('GitHub App private key not found');
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: APP_ID,
      privateKey,
      installationId: Number(installationId),
    },
  });
}
