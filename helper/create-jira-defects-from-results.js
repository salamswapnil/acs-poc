import fs from 'fs';

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  GITHUB_REPOSITORY,
  GITHUB_SHA,
  GITHUB_REF_NAME,
  GITHUB_RUN_ID,
  GITHUB_SERVER_URL = 'https://github.com',
} = process.env;

const JIRA_PROJECT_KEY = 'ACSPOC';
const JIRA_ISSUE_TYPE = 'Bug';

const resultsPath = process.argv[2] || 'test-results.json';

/**
 * Validate required configuration.
 */
function validateEnvironment() {
  const missing = [];

  if (!JIRA_BASE_URL) missing.push('JIRA_BASE_URL');
  if (!JIRA_EMAIL) missing.push('JIRA_EMAIL');
  if (!JIRA_API_TOKEN) missing.push('JIRA_API_TOKEN');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  if (!fs.existsSync(resultsPath)) {
    throw new Error(
      `Playwright JSON result file not found: ${resultsPath}`,
    );
  }
}

/**
 * Convert an unknown Playwright error value into readable text.
 */
function stripAnsi(text = '') {
  return String(text).replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    ''
  );
}

function truncateErrorMessage(text, maxLength = 28000) {
  if (!text) {
    return '';
  }

  const value = String(text);

  if (value.length <= maxLength) {
    return value;
  }

  return value.substring(0, maxLength);
}

function extractErrorText(error) {
  if (!error) {
    return '';
  }

  if (typeof error === 'string') {
    return stripAnsi(error);
  }

  return stripAnsi(
    error.message ||
    error.stack ||
    error.value ||
    JSON.stringify(error, null, 2)
  );
}

function getFailedTests(report) {
  const failedTests = [];

  /**
   * Playwright suites can be nested, so process them recursively.
   */
  function processSuite(suite) {

    // Process specs belonging directly to this suite.
    for (const spec of suite.specs || []) {

      for (const test of spec.tests || []) {

        const results = test.results || [];

        if (results.length === 0) {
          continue;
        }

        /*
         * results[] may contain multiple entries when Playwright
         * retries are enabled.
         *
         * We care about the final result.
         */
        const finalResult = results[results.length - 1];

        /*
         * Playwright uses:
         *
         * result.status = "failed"
         * test.status   = "unexpected"
         *
         * for normal unexpected failures.
         */
        const isFailed =
          finalResult.status === 'failed' ||
          finalResult.status === 'timedOut' ||
          finalResult.status === 'interrupted' ||
          test.status === 'unexpected';

        if (!isFailed) {
          continue;
        }

        /*
         * The actual JSON contains both:
         *
         * result.error
         * result.errors[]
         *
         * Prefer errors[], but fall back to error.
         */
        let errors = [];

        if (
          Array.isArray(finalResult.errors) &&
          finalResult.errors.length > 0
        ) {
          errors = finalResult.errors
            .map(extractErrorText)
            .filter(Boolean);
        } else if (finalResult.error) {
          errors = [
            extractErrorText(finalResult.error)
          ];
        }

        const stderr = (finalResult.stderr || [])
          .map(item => {
            if (typeof item === 'string') {
              return stripAnsi(item);
            }

            return stripAnsi(
              item?.text ||
              JSON.stringify(item)
            );
          })
          .filter(Boolean);

        /*
         * Find the Playwright step that actually failed.
         */
        const failedStep = (finalResult.steps || [])
          .find(step => step.error);

        /*
         * Find useful generated artifacts.
         */
        const screenshot = (finalResult.attachments || [])
          .find(
            attachment =>
              attachment.name === 'screenshot' ||
              attachment.contentType === 'image/png'
          );

        const errorContext = (finalResult.attachments || [])
          .find(
            attachment =>
              attachment.name === 'error-context'
          );

        failedTests.push({
          title:
            spec.title ||
            'Unnamed Playwright test',

          file:
            spec.file ||
            suite.file ||
            'Unknown test file',

          line:
            spec.line ?? null,

          projectName:
            test.projectName ||
            test.projectId ||
            'Unknown project',

          expectedStatus:
            test.expectedStatus ||
            'passed',

          actualStatus:
            finalResult.status ||
            'unknown',

          testStatus:
            test.status ||
            'unknown',

          retry:
            finalResult.retry ?? 0,

          duration:
            finalResult.duration ?? 0,

          errors,

          stderr,

          failedStep:
            failedStep?.title ||
            'Not available',

          errorLocation:
            finalResult.errorLocation ||
            finalResult.error?.location ||
            null,

          screenshotPath:
            screenshot?.path ||
            null,

          errorContextPath:
            errorContext?.path ||
            null,

          attachments:
            finalResult.attachments || []
        });
      }
    }

    /*
     * IMPORTANT:
     * Recursively process nested Playwright suites.
     */
    for (const childSuite of suite.suites || []) {
      processSuite(childSuite);
    }
  }

  for (const suite of report.suites || []) {
    processSuite(suite);
  }

  return failedTests;
}

/**
 * Build the GitHub Actions workflow URL when running inside GitHub.
 */
function getWorkflowUrl() {
  if (
    !GITHUB_REPOSITORY
    || !GITHUB_RUN_ID
  ) {
    return 'Not available';
  }

  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/**
 * Create ADF text paragraph.
 */
function paragraph(text) {
  return {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: String(text),
      },
    ],
  };
}

/**
 * Create ADF heading.
 */
function heading(text, level = 2) {
  return {
    type: 'heading',
    attrs: {
      level,
    },
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * Create the Jira description in Atlassian Document Format.
 */
function buildDescription(failure) {
  const errorText = failure.errors.length > 0
    ? truncateErrorMessage(failure.errors.join('\n\n'))
    : 'No structured Playwright error was provided.';

  const stderrText = failure.stderr.length > 0
    ? failure.stderr.join('\n')
    : 'No stderr output provided.';

  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(
        'This defect was created automatically by the Playwright QA automation pipeline.',
      ),

      heading('Test Details'),

      paragraph(`Test: ${failure.title}`),
      paragraph(`Test file: ${failure.file}`),
      paragraph(`Test line: ${failure.line ?? 'Not available'}`),
      paragraph(`Browser / Project: ${failure.projectName}`),
      paragraph(`Expected status: ${failure.expectedStatus}`),
      paragraph(`Actual status: ${failure.actualStatus}`),
      paragraph(`Failed step: ${failure.failedStep}`),
      paragraph(`Retry: ${failure.retry}`),
      paragraph(`Duration: ${failure.duration} ms`),

      heading('Failure Details'),

      paragraph(errorText),
    ],
  };
}

/**
 * Call Jira Cloud and create one Bug.
 */
async function createJiraDefect(failure) {
  const auth = Buffer.from(
    `${JIRA_EMAIL}:${JIRA_API_TOKEN}`,
  ).toString('base64');

  const summary = `[Automation] ${failure.title}`.slice(0, 255);

  const payload = {
    fields: {
      project: {
        key: JIRA_PROJECT_KEY,
      },

      issuetype: {
        name: JIRA_ISSUE_TYPE,
      },

      summary,

      description: buildDescription(failure),

      labels: [
        'automated-test',
        'playwright',
      ],
    },
  };

  console.log(`\n🐞 Creating Jira defect for: ${failure.title}`);

  const response = await fetch(
    `${JIRA_BASE_URL}/rest/api/3/issue`,
    {
      method: 'POST',

      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },

      body: JSON.stringify(payload),
    },
  );

  const responseBody = await response.text();

  if (!response.ok) {
    console.error(
      `❌ Failed to create Jira defect for "${failure.title}"`,
    );

    console.error(
      `Status: ${response.status}`,
    );

    console.error(
      `Response: ${responseBody}`,
    );

    return null;
  }

  const issue = JSON.parse(responseBody);

  console.log(
    `✅ Jira defect created: ${issue.key}`,
  );

  console.log(
    `${JIRA_BASE_URL}/browse/${issue.key}`,
  );

  return issue;
}

/**
 * Main program.
 */
async function main() {
  validateEnvironment();

  console.log(
    `📄 Reading Playwright results from ${resultsPath}`,
  );

  const report = JSON.parse(
    fs.readFileSync(resultsPath, 'utf8'),
  );

  const failedTests = getFailedTests(report);

  console.log(
    `🔎 Found ${failedTests.length} failed test(s).`,
  );

  if (failedTests.length === 0) {
    console.log(
      '✅ No Jira defects need to be created.',
    );

    return;
  }

  const createdIssues = [];
  const failedCreations = [];

  for (const failure of failedTests) {
    const issue = await createJiraDefect(failure);

    if (issue) {
      createdIssues.push(issue.key);
    } else {
      failedCreations.push(failure.title);
    }
  }

  console.log('\n----------------------------------');
  console.log('Jira defect creation summary');
  console.log('----------------------------------');

  console.log(
    `Failed Playwright tests: ${failedTests.length}`,
  );

  console.log(
    `Jira defects created: ${createdIssues.length}`,
  );

  if (createdIssues.length > 0) {
    console.log(
      `Created: ${createdIssues.join(', ')}`,
    );
  }

  if (failedCreations.length > 0) {
    console.error(
      `Failed Jira creations: ${failedCreations.join(', ')}`,
    );

    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    '❌ Jira defect processing failed:',
    error,
  );

  process.exit(1);
});
