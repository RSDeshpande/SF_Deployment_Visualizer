const fs = require('fs');
const { execSync } = require('child_process');

// Environment variables
const deployResultPath = process.env.DEPLOY_RESULT_PATH || './deploy_result.json';
const accessToken      = process.env.SF_ACCESS_TOKEN;
const instanceUrl      = process.env.SF_INSTANCE_URL;
const githubToken      = process.env.GITHUB_TOKEN;
const repository       = process.env.GITHUB_REPOSITORY;
const currentSha       = process.env.GITHUB_SHA;
const beforeSha        = process.env.BEFORE_SHA;
const refName          = process.env.GITHUB_REF_NAME;
const repoUrl          = process.env.REPO_URL;
const targetBranch     = process.env.TARGET_BRANCH || 'main';
const isDryRun         = process.env.DRY_RUN === 'true';
const EXEC_OPTIONS     = { timeout: 30000 };

// Validate required env vars immediately
const requiredEnvVars = {
  SF_ACCESS_TOKEN: accessToken,
  SF_INSTANCE_URL: instanceUrl,
  GITHUB_TOKEN:    githubToken,
  GITHUB_REPOSITORY: repository,
  GITHUB_SHA:      currentSha
};
const missingVars = Object.entries(requiredEnvVars)
  .filter(([, v]) => !v).map(([k]) => k);
if (missingVars.length > 0) {
  console.error('❌ Missing env vars:', missingVars.join(', '));
  process.exit(0);
}

async function main() {
  console.log('📦 Reading deploy result...');
  let deployResult = {};
  try {
    const raw = fs.readFileSync(deployResultPath, 'utf8');
    deployResult = JSON.parse(raw);
  } catch (err) {
    console.log('⚠️ Could not read deploy_result.json. Using fallback values.');
  }

  const deployId = deployResult?.result?.id
                || deployResult?.id
                || 'UNKNOWN-' + Date.now();

  const rawStatus = deployResult?.result?.status
                 || deployResult?.status
                 || 'Failed';

  const statusMap = {
    'Succeeded': 'Success', 'SucceededPartial': 'Failed',
    'Failed': 'Failed', 'Canceled': 'Failed',
    'InProgress': 'InProgress', 'Pending': 'Pending'
  };
  const deployStatus = statusMap[rawStatus] || 'Failed';
  console.log(`📋 Deploy ID: ${deployId} | Status: ${deployStatus}`);

  console.log('🔍 Getting changed files...');
  const isFirstPush = !beforeSha
    || beforeSha === '0000000000000000000000000000000000000000';

  let changedFiles = [];
  try {
    const cmd = isFirstPush
      ? `git diff-tree --no-commit-id -r --name-status ${currentSha}`
      : `git diff --name-status ${beforeSha} ${currentSha}`;
    changedFiles = getChangedFilesFromGit(cmd);
  } catch (e) {
    console.log('⚠️ Could not get changed files:', e.message);
  }

  // Filter to force-app/ only
  changedFiles = changedFiles.filter(
    f => f.path && f.path.startsWith('force-app/')
  );
  console.log(`📁 Found ${changedFiles.length} changed files in force-app/`);

  const artifacts = changedFiles.map(file => {
    let author = 'Unknown';
    try {
      author = execSync(
        `git log -1 --format="%an" -- "${file.path}"`, EXEC_OPTIONS
      ).toString().trim()
        .replace(/[^\w\s.\-@]/g, '')
        .substring(0, 255);
    } catch (e) {}

    return {
      name: extractMetadataName(file.path),
      type: mapToMetadataType(file.path),
      filePath: file.path,
      author: author || 'Unknown',
      changeType: mapChangeType(file.status),
      prNumber: 0
    };
  });

  console.log('🐙 Fetching PR details from GitHub...');
  const logCmd = isFirstPush
    ? `git log ${currentSha} -10 --format="%H|||%s|||%an|||%ae"`
    : `git log ${beforeSha}..${currentSha} --format="%H|||%s|||%an|||%ae"`;

  let logOutput = '';
  try {
    logOutput = execSync(logCmd, EXEC_OPTIONS).toString().trim();
  } catch (e) {
    console.log('⚠️ Could not get git log:', e.message);
  }

  const commits = logOutput.split('\n').filter(Boolean).map(line => {
    const parts = line.split('|||');
    return {
      hash: parts[0], subject: parts[1] || '',
      authorName: parts[2], authorEmail: parts[3]
    };
  });

  const prNumbersFromMessages = [...new Set(
    commits.map(c => {
      const match = c.subject?.match(/#(\d+)/);
      return match ? parseInt(match[1]) : null;
    }).filter(Boolean)
  )];

  const prs = [];
  for (const prNumber of prNumbersFromMessages) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
        { headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json'
          }
        }
      );

      // Log rate limit status
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining && parseInt(remaining) < 10) {
        console.log(`⚠️ GitHub rate limit low: ${remaining} remaining`);
      }

      if (!response.ok) {
        console.log(`⚠️ PR #${prNumber} not found: ${response.status}`);
        continue;
      }

      const pr = await response.json();
      prs.push({
        number: pr.number, title: pr.title,
        url: pr.html_url, author: pr.user.login,
        mergedAt: pr.merged_at,
        sourceBranch: pr.head.ref, targetBranch: pr.base.ref
      });

      // Link artifacts to this PR
      const filesResponse = await fetch(
        `https://api.github.com/repos/${repository}/pulls/${prNumber}/files`,
        { headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json'
          }
        }
      );
      if (filesResponse.ok) {
        const prFiles = await filesResponse.json();
        const prFilePaths = prFiles.map(f => f.filename);
        artifacts.forEach(artifact => {
          if (prFilePaths.includes(artifact.filePath)) {
            artifact.prNumber = prNumber;
          }
        });
      }
    } catch (e) {
      console.log(`⚠️ Error fetching PR #${prNumber}:`, e.message);
    }
  }

  const authors = [...new Set([
    ...prs.map(pr => pr.author),
    ...artifacts.map(a => a.author)
  ])].filter(a => a && a !== 'Unknown');

  const finalArtifacts = artifacts.filter(a => a.type !== 'Unknown');

  const payload = {
    deployId, deployStatus,
    sourceBranch: refName,
    targetBranch,
    commitSha: currentSha,
    repoUrl, deployedAt: new Date().toISOString(),
    prs, artifacts: finalArtifacts, authors
  };

  console.log(`📊 Payload: ${prs.length} PRs, ${finalArtifacts.length} artifacts, ${authors.length} authors`);

  if (isDryRun) {
    console.log('DRY RUN:', JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  console.log('🚀 Sending webhook to Salesforce...');
  await sendWithRetry(payload);
}

async function sendWithRetry(payload, retries = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  try {
    const response = await fetch(
      `${instanceUrl}/services/apexrest/dtrack/deployment`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HTTP ${response.status}: ${err}`);
    }
    const result = await response.json();
    console.log('✅ Webhook sent successfully:', result);
  } catch (error) {
    if (retries < MAX_RETRIES) {
      console.log(`⚠️ Retry ${retries + 1}/${MAX_RETRIES}:`, error.message);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return sendWithRetry(payload, retries + 1);
    }
    console.error('❌ Webhook failed after all retries:', error.message);
    console.log('📦 Failed payload:', JSON.stringify(payload, null, 2));
    process.exit(0); // Don't fail pipeline
  }
}

function getChangedFilesFromGit(cmd) {
  const result = execSync(cmd, EXEC_OPTIONS).toString().trim();
  if (!result) return [];
  return result.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const status = parts[0][0];
    const path = parts.length > 2 ? parts[2] : parts[1];
    return { status, path };
  });
}

function mapToMetadataType(filePath) {
  const mappings = {
    '.cls-meta.xml':              'ApexClass',
    '.trigger-meta.xml':          'ApexTrigger',
    '.js-meta.xml':               'LightningComponentBundle',
    '.cls':                       'ApexClass',
    '.trigger':                   'ApexTrigger',
    '.html':                      'LightningComponentBundle',
    '.js':                        'LightningComponentBundle',
    '.css':                       'LightningComponentBundle',
    '.object-meta.xml':           'CustomObject',
    '.field-meta.xml':            'CustomField',
    '.flow-meta.xml':             'Flow',
    '.layout-meta.xml':           'Layout',
    '.permissionset-meta.xml':    'PermissionSet',
    '.profile-meta.xml':          'Profile',
    '.page-meta.xml':             'ApexPage',
    '.component-meta.xml':        'AuraDefinitionBundle',
    '.resource-meta.xml':         'StaticResource',
    '.flexipage-meta.xml':        'FlexiPage',
    '.validationRule-meta.xml':   'ValidationRule',
    '.workflow-meta.xml':         'Workflow'
  };
  for (const [ext, type] of Object.entries(mappings)) {
    if (filePath.endsWith(ext)) return type;
  }
  return 'Unknown';
}

function extractMetadataName(filePath) {
  const fileName = filePath.split('/').pop();
  return fileName.split('.')[0];
}

function mapChangeType(gitStatus) {
  const map = {
    'A': 'Added', 'M': 'Modified',
    'D': 'Deleted', 'R': 'Modified'
  };
  return map[gitStatus] || 'Modified';
}

main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});