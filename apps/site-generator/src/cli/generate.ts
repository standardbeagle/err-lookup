#!/usr/bin/env node

import { generateSite, generateAllSites } from '../generator.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--all') {
    console.log('Generating sites for all completed repositories...\n');
    const sites = await generateAllSites();
    console.log(`\nGenerated ${sites.length} sites`);
    for (const site of sites) {
      console.log(`  - ${site}`);
    }
  } else {
    const repoFullName = args[0];
    // Convert URL to owner/repo format if needed
    const match = repoFullName.match(/github\.com\/([^/]+\/[^/]+)/);
    const normalizedName = match ? match[1].replace(/\.git$/, '') : repoFullName;

    console.log(`Generating site for ${normalizedName}...\n`);
    const siteDir = await generateSite(normalizedName);
    console.log(`\nSite generated at: ${siteDir}`);
    console.log(`\nTo preview the site, run:`);
    console.log(`  cd ${siteDir} && pnpm install && pnpm start`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
