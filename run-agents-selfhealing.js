import { OpenAI } from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const targetUrl = "https://main--credera-poc--credera-accelerators.aem.live/vaccines-successes-and-efforts-submission-form";

// Helper function to safely load system prompt files with a fallback
function loadSystemPrompt(relativePath, defaultPrompt) {
  try {
    const fullPath = path.resolve(process.cwd(), relativePath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      console.log(`📄 Loaded system prompt from ${relativePath}`);
      return content;
    }
  } catch (error) {
    console.warn(`⚠️ Could not read prompt at ${relativePath}, using default.`);
  }
  return defaultPrompt;
}

async function runDynamicMcpAgent() {
  console.log("🎭 Spawning Playwright MCP Server ");

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['--yes', '@playwright/mcp@latest','--headless']
  });

  const mcpClient = new Client(
    { name: 'qa-mcp-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await mcpClient.connect(transport);
  console.log("✅ Connected to Playwright MCP Server successfully.");

  let testPlan = "";

  try {
    const openai = new OpenAI({
      apiKey: "sk-HMz6ktPos3Qas8bZiQHquw",
      baseURL: "https://credera.ai.omcpmg.com/modelvend/proxy"
    });

    const mcpToolsList = await mcpClient.listTools();
    
    // Combine MCP tools and the file reading tool
    const openAiTools = [
      ...mcpToolsList.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      })),
      {
        type: 'function',
        function: {
          name: 'readWorkspaceFile',
          description: 'Read the contents of a file from the workspace codebase when needed.',
          parameters: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'The relative path to the file (e.g., .skills/testplanner/requirement.md or specs/automated-plan.md)'
              }
            },
            required: ['filePath']
          }
        }
      }
    ];

    console.log(`🛠️ Discovered ${openAiTools.length} total tools (including workspace reader).`);

    // --- Load Requirements ---
    const requirementPath = path.resolve(process.cwd(), '.skills/testplanner/requirement.md');
    let requirementContent = "";
    
    if (fs.existsSync(requirementPath)) {
      requirementContent = fs.readFileSync(requirementPath, 'utf8');
      console.log("📄 Successfully loaded requirements from .skills/testplanner/requirement.md");
    } else {
      throw new Error(`Requirement file not found at: ${requirementPath}`);
    }

    // --- Load Planner System Prompt ---
    const plannerSystemPrompt = loadSystemPrompt(
      '.claude/agents/playwright-test-planner.md',
      "You are an autonomous browser testing agent. Use the provided Playwright MCP tools to navigate to the target URL, inspect the DOM, and interact with page elements to fulfill the user's specific testing requirements."
    );

    const messages = [
      {
        role: "system",
        content: plannerSystemPrompt + "\n\nCRITICAL INSTRUCTION: When you have finished your exploration and are ready to conclude, your final response must NOT be conversational. Output ONLY the complete, detailed markdown test plan and test cases (with title, description, test steps, and expected result, limited to 10 critical test cases) so it can be saved directly to a file."
      },
      {
        role: "user",
        content: `IMPORTANT: You must first use the Playwright MCP tools to navigate to this exact URL: ${targetUrl}\n\nHere are the testing requirements:\n\n${requirementContent}\n\nPlease explore the page, inspect elements according to these requirements, and generate a comprehensive markdown test plan along with test cases with title, description, test steps, and expected result limited to 10 test cases and cover critical scenarios.`
      }
    ];

    let keepLooping = true;

    // --- STAGE 1: PLANNER & EXPLORER AGENT (MCP Loop) ---
    console.log("🤖 Stage 1: Running live browser exploration & generating test cases...");
    while (keepLooping) {
      const response = await openai.chat.completions.create({
        model: "claude-sonnet-4-5",
        messages: messages,
        tools: openAiTools,
        temperature: 0.1
      });

      const choice = response.choices[0];
      if (!choice || !choice.message) {
        console.warn("⚠️ Received empty response choice from OpenAI proxy.");
        break;
      }

      messages.push(choice.message);

      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        for (const toolCall of choice.message.tool_calls) {
          const toolName = toolCall.function.name;
          let toolArgs = {};
          
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || "{}");
          } catch (parseError) {
            console.warn(`⚠️ Failed to parse arguments for tool ${toolName}:`, toolCall.function.arguments);
          }

          console.log(`🔧 Executing Tool [${toolName}] with args:`, toolArgs);

          try {
            let toolResultContent = "";

            if (toolName === 'readWorkspaceFile') {
              const absolutePath = path.resolve(process.cwd(), toolArgs.filePath);
              toolResultContent = fs.readFileSync(absolutePath, 'utf8');
            } else {
              const mcpResult = await mcpClient.callTool({
                name: toolName,
                arguments: toolArgs
              });
              toolResultContent = JSON.stringify(mcpResult.content || mcpResult);
            }

            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResultContent
            });
            console.log(`✅ Tool [${toolName}] executed successfully.`);
          } catch (toolError) {
            console.error(`❌ Error executing tool ${toolName}:`, toolError.message || toolError);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: toolError.message })
            });
          }
        }
      } else {
        testPlan = choice.message.content || "";
        keepLooping = false;
      }
    }

    const specsDir = path.resolve(process.cwd(), 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'automated-plan.md'), testPlan);
    console.log("📝 Saved comprehensive test plan and cases to ./specs/automated-plan.md");

    // --- Stage 2: Automation Script Generation ---
    const generatorSystemPrompt = loadSystemPrompt(
      '.claude/agents/playwright-test-generator.md',
      "You are an expert automation engineer. Use the provided Playwright MCP tools to navigate to the target URL, verify the elements required for each test case from the markdown plan, and write clean, robust, executable Playwright JavaScript test scripts using ES modules (import/export). Always wrap your final code block in ```javascript."
    );

    const generatorMessages = [
      {
        role: "system",
        content: generatorSystemPrompt
      },
      {
        role: "user",
        content: `Based on the requirements and manual test cases (which you can fetch via the readWorkspaceFile tool if needed from .skills/testplanner/requirement.md and specs/automated-plan.md), generate deterministic, executable Playwright JavaScript test cases for the target URL: ${targetUrl} using live-DOM grounding via Playwright MCP and ES modules (import/export). 

**Role & Rules**
* Act as a Senior QA Automation Engineer. Never invent selectors, improvise behavior, or assert unstated conditions.
* **MCP Discovery:** Navigate to the target URL, interact with the UI, capture snapshots as the sole source of truth, and copy attribute values verbatim.
* **Selector Hierarchy:** Use \`getByRole\` first, followed by \`getByLabel\`, \`getByPlaceholder\`, \`getByAltText\`, \`getByTitle\`, \`getByTestId\`, \`getByText\`, and lastly CSS \`page.locator(...)\` with a \`// locator-justification:\` comment. Hard ban on \`page.locator\` when built-in semantic/role locators apply.
* **Anti-Hallucination:** Do not treat visual cues (\`*\`, colors) as text. Only assert \`toBeFocused()\` after explicit, deterministic focus actions. Avoid \`page.waitForTimeout\` or \`networkidle\`; use web-first assertions. Do not assume post-submit form persistence.
* **API Guardrails:** Use built-in Playwright assertions (\`toHaveValue\`, \`toBeChecked\`, etc.). Hard ban on \`page.evaluate\` unless justified (\`// evaluate-justification:\` with a JSDoc type cast). Keep tests independent using unique test data (\`Date.now()\`). Do NOT include type definitions, TypeScript syntax, or interface annotations.

**Output Structure**
Return **exactly** these four sections:
1. **\`Detected Manual Test Cases\`**: Numbered list ending with \`Total: N\`.
2. **\`Assumptions & Gaps\`**: Bullet list of unverified elements or gaps (or \`None\`).
3. **\`Traceability Matrix\`**: Sub-tables mapping steps to \`test.step\` labels, locators (with DOM evidence), and assertions.
4. **\`Generated Test\`**: Single fenced \`\`\`javascript code block containing ESM imports, a \`test.beforeEach\` setup, and exactly \`N\` \`test(...)\` blocks matching manual test case titles verbatim.`
      }
    ];

    let keepGenerating = true;
    let finalScriptCode = "";

    console.log("🤖 Stage 2: Running browser inspection & generating Playwright test code...");

    while (keepGenerating) {
      const response = await openai.chat.completions.create({
        model: "claude-sonnet-4-5",
        messages: generatorMessages,
        tools: openAiTools,
        temperature: 0.1
      });

      const choice = response.choices[0];
      if (!choice || !choice.message) {
        console.warn("⚠️ Received empty response choice from OpenAI proxy.");
        break;
      }

      generatorMessages.push(choice.message);

      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        for (const toolCall of choice.message.tool_calls) {
          const toolName = toolCall.function.name;
          let toolArgs = {};
          
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || "{}");
          } catch (parseError) {
            console.warn(`⚠️ Failed to parse arguments for tool ${toolName}:`, toolCall.function.arguments);
          }

          console.log(`🔧 Gen Agent Executing Tool [${toolName}]...`);

          try {
            let toolResultContent = "";

            if (toolName === 'readWorkspaceFile') {
              const absolutePath = path.resolve(process.cwd(), toolArgs.filePath);
              toolResultContent = fs.readFileSync(absolutePath, 'utf8');
            } else {
              const mcpResult = await mcpClient.callTool({
                name: toolName,
                arguments: toolArgs
              });
              toolResultContent = JSON.stringify(mcpResult.content || mcpResult);
            }

            generatorMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResultContent
            });
            console.log(`✅ Tool [${toolName}] executed successfully.`);
          } catch (toolError) {
            console.error(`❌ Error executing tool ${toolName}:`, toolError.message || toolError);
            generatorMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: toolError.message })
            });
          }
        }
      } else {
        finalScriptCode = choice.message.content || "";
        keepGenerating = false;
      }
    }

    let jsCodeMatch = finalScriptCode.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
    let finalCode = "";

    if (jsCodeMatch && jsCodeMatch[1]) {
      finalCode = jsCodeMatch[1].trim();
    } else {
      console.warn("⚠️ Generator output missing standard code blocks. Attempting fallback cleanup...");
      finalCode = finalScriptCode.replace(/^[\s\S]*?import\s/i, 'import ').trim();
      if (!finalCode.startsWith('import') && !finalCode.includes('test(')) {
        throw new Error("No valid executable Playwright code block found in Generator output.");
      }
    }

    const testsDir = path.resolve(process.cwd(), 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, 'agent-generated.spec.js'), finalCode);
    console.log("💻 Successfully wrote interactive agent-generated test script to ./tests/agent-generated.spec.js");

    // --- STAGE 3: HEALER AGENT (Self-Healing Execution Loop) ---
    console.log("🤖 Stage 3: Entering Self-Healing Execution Loop...");
    let maxRetries = 1;
    let attempt = 1;
    let testPassed = false;
    let lastErrorMessage = "";

    const healerSystemPrompt = loadSystemPrompt(
      '.claude/agents/playwright-test-healer.md',
      "You are an expert QA Self-Healing Agent. Your job is to analyze broken Playwright JavaScript test scripts along with their execution error logs, fix locator or syntax bugs, and return a corrected, fully executable script inside a ```javascript code block."
    );

    while (attempt <= maxRetries && !testPassed) {
      console.log(`\n🔄 Test Execution Attempt ${attempt} of ${maxRetries}...`);
      try {
        execSync("npx playwright test tests/agent-generated.spec.js", { encoding: 'utf8' });
        console.log("✨ Test execution passed successfully!");
        testPassed = true;
      } 
      catch (executionError) {
        lastErrorMessage = executionError.stderr || executionError.stdout || executionError.message || String(executionError);
        console.warn(`⚠️ Test failed on attempt ${attempt}.`);
        console.warn("🩹 Engaging Healer Agent...");

        if (attempt >= maxRetries) {
          console.error("❌ Max self-healing retries reached. Test script could not be automatically fixed.");
          throw executionError;
        }

        const testFilePath = 'tests/agent-generated.spec.js';
        const currentCode = fs.readFileSync(testFilePath, 'utf8');

        let sanitizedErrorMessage = lastErrorMessage
          .replace(/[<>]/g, '')           
          .replace(/[\x00-\x1F\x7F]/g, ''); 

        if (sanitizedErrorMessage.length > 1000) {
          sanitizedErrorMessage = sanitizedErrorMessage.slice(-1000);
        }

        let sanitizedCode = currentCode
          .replace(/[\x00-\x1F\x7F]/g, ''); 

        if (sanitizedCode.length > 2000) {
          sanitizedCode = sanitizedCode.slice(0, 2000) + "\n// ... [truncated for firewall payload safety]";
        }

        const healerResponse = await openai.chat.completions.create({
          model: "claude-sonnet-4-5", 
          messages: [
            {
              role: "system",
              content: healerSystemPrompt
            },
            {
              role: "user",
              content: `The following Playwright test script failed during execution:\n\n\`\`\`javascript\n${sanitizedCode}\n\`\`\`\n\nExecution Error Log:\n\`\`\`text\n${sanitizedErrorMessage}\n\`\`\`\n\nPlease fix the script logic, selectors, or syntax errors based on this error. Return ONLY the raw corrected JavaScript inside a \`\`\`javascript code block.`
            }
          ],
          temperature: 0.1
        });

        const healerOutput = healerResponse.choices[0]?.message?.content;
        const fixedCodeMatch = healerOutput?.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);

        if (fixedCodeMatch) {
          const healedCode = fixedCodeMatch[1].trim();
          fs.writeFileSync(testFilePath, healedCode);
          console.log("🩹 Healer Agent applied code fixes. Rewrote ./tests/agent-generated.spec.js");
        } else {
          console.warn("⚠️ Healer Agent failed to output code block.");
        }

        attempt++;
      }
    }
  } 
  finally {
    console.log("🛑 Closing MCP client and shutting down background process...");
    await mcpClient.close();
  }
}

runDynamicMcpAgent().catch((err) => {
  console.error("❌ Pipeline Failed:", err);
  process.exit(1);
});
