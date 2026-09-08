import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateAccessibilityHtmlReport, sanitizeFileName } from '../helper/accessibilityreport.js';

test.describe('homepage form accessibility', () => {
  test('form accessibility issues including interactive states', async ({ page }, testInfo) => {
    // 1. Navigate and wait for network/JS to fully settle
    await page.goto('https://main--credera-poc--credera-accelerators.aem.live/hpv-vaccines-successes-and-efforts-submission-form?_test', {
      waitUntil: 'networkidle',
    });

    const submitButton = page.locator('button[type="submit"]');
    if (await submitButton.isVisible()) {
      await submitButton.click();
      // Wait for error messages to render in the DOM
      await page.waitForTimeout(500); 
    }

    // 3. Run AxeBuilder with explicit WCAG tags if needed
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']) // Focus on official compliance standards
      .analyze();

    const outputDir = resolve(process.cwd(), 'accessibility');
    const reportBaseName = sanitizeFileName(testInfo.title);
    const jsonFileName = `${reportBaseName}.json`;

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, jsonFileName), JSON.stringify(accessibilityScanResults, null, 2), 'utf8');
    await generateAccessibilityHtmlReport(accessibilityScanResults, outputDir, reportBaseName);

    // 4. Fail the test if any accessibility violations were found
    expect(
      accessibilityScanResults.violations,
      `Accessibility violations found: ${accessibilityScanResults.violations.length}`
    ).toEqual([]);
  });
});
