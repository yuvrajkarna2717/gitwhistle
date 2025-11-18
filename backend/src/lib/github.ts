import fs from "node:fs";
import path from "node:path";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
dotenv.config();

const APP_ID = Number(process.env.GITHUB_APP_ID);
const PRIVATE_KEY_PATH =
  process.env.GITHUB_APP_PRIVATE_KEY_PATH || "./keys/github_app.pem";

const privateKey = fs.readFileSync(path.resolve(PRIVATE_KEY_PATH), "utf8");

const app = new App({ appId: APP_ID, privateKey });

// create an Octokit authenticated as the app (JWT-based)
export function getAppOctokit() {
  const jwt = app.getSignedJsonWebToken();
  return new Octokit({ auth: jwt });
}

// create octokit for an installation (installation token)
// installationId is the GitHub installation id (big int)
export async function getInstallationOctokit(installationId: number | string) {
  const installationAccessToken = await app.getInstallationAccessToken({
    installationId: Number(installationId),
  });

  return new Octokit({ auth: installationAccessToken });
}
