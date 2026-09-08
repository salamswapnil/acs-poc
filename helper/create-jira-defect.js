const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
} = process.env;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  throw new Error(
    'Missing required environment variables: JIRA_BASE_URL, JIRA_EMAIL or JIRA_API_TOKEN',
  );
}

const auth = Buffer.from(
  `${JIRA_EMAIL}:${JIRA_API_TOKEN}`,
).toString('base64');

const payload = {
  fields: {
    project: {
      key: 'ACSPOC',
    },
    summary: '[Automation POC] Playwright test failure',
    description: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'This is a test defect created automatically by the Playwright QA automation POC.',
            },
          ],
        },
      ],
    },
    issuetype: {
      name: 'Bug',
    },
  },
};

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
  console.error('❌ Jira defect creation failed');
  console.error(`Status: ${response.status}`);
  console.error(`Response: ${responseBody}`);

  process.exit(1);
}

const issue = JSON.parse(responseBody);

console.log('✅ Jira defect created successfully');
console.log(`Issue Key: ${issue.key}`);
console.log(`Issue URL: ${JIRA_BASE_URL}/browse/${issue.key}`);
