import { promises as fs } from "fs";
import path from "upath";
import * as api from "./api";
import * as logger from "./logger";
import * as semver from "./semver";
import type { PlasmicOpts } from "./types";
import * as config from "./config";
import execa from "execa";

export function getEnv() {
  return {
    QUIET: "1",
    ...process.env,
    PLASMIC_LOADER: "1",
    npm_config_yes: "1",
    NODE_OPTIONS: process.env.LOADER_CLI_NODE_OPTIONS,
  };
}

async function runCommand(
  command: string,
  opts: { dir?: string; hideOutput?: boolean } = {}
) {
  if (!opts.dir) opts.dir = process.cwd();
  if (!opts.hideOutput) opts.hideOutput = false;
  const [file, ...args] = command.split(" ");
  return execa(file, args, {
    cwd: opts.dir,
    env: getEnv(),
    stdio: opts.hideOutput ? "pipe" : "inherit",
  });
}

function objToExecArgs(obj: object) {
  return Object.entries(obj)
    .map(
      ([param, value]) =>
        `--${param}=${Array.isArray(value) ? value.join(",") : value}`
    )
    .join(" ");
}

export function getCurrentUser() {
  return runCommand("npx -p @plasmicapp/cli@latest plasmic auth --email")
    .then(({ stdout }) => stdout)
    .catch((error) => {
      // If the error is that the user's credentials are invalid, return no user.
      if (error.message?.includes("authentication credentials")) {
        return "";
      }
      throw error;
    });
}

export async function ensureRequiredLoaderVersion() {
  const requiredVersions = await api.getRequiredPackages().catch((error) => {
    let message = `Unable to verify loader version. Error: ${error.message}.`;
    if (error.response) {
      message += `\n\n${error.response.data}`;
    }
    throw new Error(message);
  });
  const version = config.packageJson.version;

  if (semver.gt(requiredVersions["@plasmicapp/loader"], version)) {
    logger.crash(
      "A newer version of @plasmicapp/loader is required. Please upgrade your current version and try again."
    );
  }
}

async function installPackages(plasmicDir: string) {
  await fs.writeFile(
    path.join(plasmicDir, "package.json"),
    `{
  "name":"plasmic-loader",
  "version":"0.0.1",
  "dependencies": {
    "@plasmicapp/react-web": "latest"
  }
}`
  );
  if (process.env.DO_YALC_ADD_CLI) {
    await runCommand("yalc add @plasmicapp/cli", {
      dir: plasmicDir,
      hideOutput: true,
    });
  }
  if (!process.env.NO_INSTALL) {
    await runCommand("npm update --no-package-lock --legacy-peer-deps", {
      dir: plasmicDir,
    });
  }
}

export async function tryInitializePlasmicDir(
  plasmicDir: string,
  initArgs: PlasmicOpts["initArgs"] = {}
) {
  await fs.mkdir(plasmicDir, { recursive: true });
  await installPackages(plasmicDir);
  const configPath = path.join(plasmicDir, "plasmic.json");

  try {
    await fs.access(configPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await runCommand(
      `npx -p @plasmicapp/cli@latest plasmic init --enable-skip-auth ${objToExecArgs(
        initArgs
      )}`,
      { dir: plasmicDir }
    );
  }
}

export async function readConfig(dir: string) {
  const configPath = path.join(dir, "plasmic.json");
  const configData = await fs.readFile(configPath);
  return JSON.parse(configData.toString());
}

export async function saveConfig(dir: string, config: any) {
  const configPath = path.join(dir, "plasmic.json");
  return fs.writeFile(configPath, JSON.stringify(config, undefined, 2));
}

export async function fixImports(dir: string) {
  return runCommand("npx -p @plasmicapp/cli@latest plasmic fix-imports", {
    dir,
  });
}

function getPageUrl(path: string) {
  // Convert a page path (like pages/my-page.tsx or ../pages/index.jsx) into their
  // corresponding path (/my-page).
  let [_, url] = path.split(/pages(.*)\..*$/);

  // Remove the ending "/index" path, which is required for file routing but not for URLs.
  // Examples:
  // /index -> /
  // /index/index -> /index

  if (url.endsWith("index")) {
    url = url.slice(0, -6);
  }
  return url === "" ? "/" : url;
}

export function getPagesFromConfig(plasmicDir: string, config: any) {
  const componentData: {
    name: string;
    projectId: string;
    path: string;
    url: string;
  }[] = [];
  for (const project of config.projects) {
    for (const component of project.components) {
      if (component.componentType !== "page") {
        continue;
      }
      componentData.push({
        name: component.name,
        projectId: project.projectId,
        path: path.join(plasmicDir, component.importSpec.modulePath),
        url: getPageUrl(component.importSpec.modulePath),
      });
    }
  }

  return componentData;
}

export async function syncProject(
  dir: string,
  userDir: string,
  projects: string[]
) {
  return runCommand(
    [
      "npx -p @plasmicapp/cli@latest plasmic sync",
      "--yes",
      "--metadata source=loader",
      "--loader-config",
      path.join(userDir, "plasmic-loader.json"),
      "--projects",
      ...projects,
    ].join(" "),
    {
      dir,
    }
  );
}
