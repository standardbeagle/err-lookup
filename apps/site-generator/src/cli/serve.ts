#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_DIR = path.resolve(__dirname, '../../../../sites');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // List available sites
    console.log('Available sites:\n');

    if (!await fs.pathExists(SITES_DIR)) {
      console.log('No sites generated yet. Run `pnpm generate` first.');
      process.exit(1);
    }

    const owners = await fs.readdir(SITES_DIR);
    let hasSites = false;

    for (const owner of owners) {
      const ownerPath = path.join(SITES_DIR, owner);
      if ((await fs.stat(ownerPath)).isDirectory()) {
        const repos = await fs.readdir(ownerPath);
        for (const repo of repos) {
          console.log(`  ${owner}/${repo}`);
          hasSites = true;
        }
      }
    }

    if (!hasSites) {
      console.log('No sites generated yet. Run `pnpm generate` first.');
    } else {
      console.log('\nUsage: pnpm serve <owner/repo>');
    }
    process.exit(0);
  }

  const repoFullName = args[0];
  const [owner, repo] = repoFullName.split('/');

  if (!owner || !repo) {
    console.error('Invalid repo name. Use format: owner/repo');
    process.exit(1);
  }

  const siteDir = path.join(SITES_DIR, owner, repo);

  if (!await fs.pathExists(siteDir)) {
    console.error(`Site not found: ${siteDir}`);
    console.error('Run `pnpm generate` first to generate the site.');
    process.exit(1);
  }

  // Check if node_modules exists
  const nodeModulesPath = path.join(siteDir, 'node_modules');
  if (!await fs.pathExists(nodeModulesPath)) {
    console.log('Installing dependencies...');
    const install = spawn('pnpm', ['install', '--ignore-workspace'], {
      cwd: siteDir,
      stdio: 'inherit',
    });

    await new Promise<void>((resolve, reject) => {
      install.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pnpm install failed with code ${code}`));
      });
    });
  }

  console.log(`\nStarting Docusaurus dev server for ${repoFullName}...`);
  console.log(`Site directory: ${siteDir}\n`);

  const serve = spawn('npx', ['docusaurus', 'start'], {
    cwd: siteDir,
    stdio: 'inherit',
  });

  serve.on('close', (code) => {
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
