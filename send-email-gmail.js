import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendEmail() {
  try {
    const emails = process.env.EMAIL_TO
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    const runUrl =
      process.env.GITHUB_SERVER_URL &&
      process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : 'N/A';

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: emails.join(','),
      subject: 'QA Test Report - Automation Results',
      html: `
        <h2>QA Test Execution Complete</h2>
        <p>The QA automation run has finished. All reports (Playwright, accessibility, test cases) are available as downloadable artifacts on the GitHub Actions run page below:</p>
        <p><a href="${runUrl}">${runUrl}</a></p>
        <p>Go to the run page → scroll to the bottom → download the artifacts you need (playwright-report, automation-scripts, test-results-json).</p>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.response);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

sendEmail();