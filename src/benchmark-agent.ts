#!/usr/bin/env node
/**
 * Benchmark comparing Claude Agent SDK performance with and without osgrep
 * 
 * This benchmark demonstrates the value of osgrep by comparing:
 * - Speed: Time to complete the task
 * - Cost: Token usage and USD cost
 * - Efficiency: Number of tool calls and files read
 * 
 * Uses the Claude Agent SDK (not Skills API) so Claude can call the osgrep CLI
 * via the Bash tool on the local system with pre-indexed repositories.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'path';
import chalk from 'chalk';

interface BenchmarkResult {
	duration_ms: number;
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	cache_creation_tokens?: number;
	cache_read_tokens?: number;
	tool_calls: number;
	files_read: number;
	result: string;
	error?: string;
}

interface BenchmarkComparison {
	question: string;
	repository: string;
	without_osgrep: BenchmarkResult | null;
	with_osgrep: BenchmarkResult | null;
}

/**
 * Run a single test with or without osgrep plugin/skill
 */
async function runTest(
	question: string,
	repoPath: string,
	useOsgrep: boolean
): Promise<BenchmarkResult> {
	const startTime = Date.now();
	let toolCalls = 0;
	let filesRead = 0;
	let bashCalls = 0;

	try {
		// Build query options
		const options: any = {
			cwd: repoPath,
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code'
			},
			allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
			permissionMode: 'bypassPermissions' as const, // Auto-approve for benchmarking
		};

		// Load osgrep plugin/skill if enabled
		if (useOsgrep) {
			// Load the osgrep plugin which contains the skill
			options.plugins = [
				{
					type: 'local' as const,
					path: join(__dirname, '../plugins/osgrep')
				}
			];
		}

		// Execute the query using Agent SDK
		const result = query({
			prompt: question,
			options
		});

		let finalResult: SDKResultMessage | null = null;
		let resultText = '';

		// Collect results from the async generator
		for await (const msg of result) {
			// Count tool uses
			if (msg.type === 'assistant' && 'message' in msg) {
				const assistantMsg = msg.message;
				if (Array.isArray(assistantMsg.content)) {
					for (const block of assistantMsg.content) {
						if (block.type === 'tool_use') {
							toolCalls++;
							// Count specific tool types based on name
							const toolName = block.name;
							if (toolName === 'Read') {
								filesRead++;
							} else if (toolName === 'Bash') {
								bashCalls++;
							}
						}
					}
				}
			}

			// Extract final result
			if (msg.type === 'result') {
				finalResult = msg as SDKResultMessage;
				if (msg.subtype === 'success') {
					resultText = msg.result;
				}
			}
		}

		if (!finalResult) {
			throw new Error('No result message received');
		}

		const duration_ms = Date.now() - startTime;

		return {
			duration_ms,
			cost_usd: finalResult.total_cost_usd,
			input_tokens: finalResult.usage.input_tokens,
			output_tokens: finalResult.usage.output_tokens,
			cache_creation_tokens: finalResult.usage.cache_creation_input_tokens,
			cache_read_tokens: finalResult.usage.cache_read_input_tokens,
			tool_calls: toolCalls,
			files_read: filesRead,
			result: resultText
		};
	} catch (error) {
		return {
			duration_ms: Date.now() - startTime,
			cost_usd: 0,
			input_tokens: 0,
			output_tokens: 0,
			tool_calls: 0,
			files_read: 0,
			result: '',
			error: error instanceof Error ? error.message : String(error)
		};
	}
}


/**
 * Run a complete benchmark comparison
 */
async function runBenchmark(
	question: string,
	repoPath: string
): Promise<BenchmarkComparison> {
	console.log(chalk.bold('\n🔬 Running Benchmark'));
	console.log(chalk.dim('─'.repeat(60)));
	console.log(chalk.cyan('Question:'), question);
	console.log(chalk.cyan('Repository:'), repoPath);
	console.log(chalk.dim('─'.repeat(60)));

	// Run test WITHOUT osgrep plugin
	console.log(chalk.yellow('\n⏱️  Running WITHOUT osgrep skill...'));
	const withoutOsgrep = await runTest(question, repoPath, false);
	
	if (withoutOsgrep.error) {
		console.log(chalk.red('✗ Failed:'), withoutOsgrep.error);
	} else {
		console.log(chalk.green(`✓ Completed in ${(withoutOsgrep.duration_ms / 1000).toFixed(1)}s`));
	}

	// Run test WITH osgrep plugin/skill
	console.log(chalk.yellow('\n⏱️  Running WITH osgrep skill...'));
	const withOsgrep = await runTest(question, repoPath, true);
	
	if (withOsgrep.error) {
		console.log(chalk.red('✗ Failed:'), withOsgrep.error);
	} else {
		console.log(chalk.green(`✓ Completed in ${(withOsgrep.duration_ms / 1000).toFixed(1)}s`));
	}

	return {
		question,
		repository: repoPath,
		without_osgrep: withoutOsgrep,
		with_osgrep: withOsgrep
	};
}

/**
 * Display benchmark results in a formatted table
 */
function displayResults(comparison: BenchmarkComparison): void {
	const { without_osgrep: without, with_osgrep: with_ } = comparison;

	if (!without || !with_) {
		console.log(chalk.red('\n❌ Incomplete benchmark results'));
		return;
	}

	console.log(chalk.bold('\n📊 Benchmark Results'));
	console.log(chalk.dim('═'.repeat(80)));

	// Calculate improvements
	const timeImprovement = without.duration_ms / with_.duration_ms;
	const costSavings = ((without.cost_usd - with_.cost_usd) / without.cost_usd) * 100;
	const tokenReduction = ((without.input_tokens - with_.input_tokens) / without.input_tokens) * 100;
	const toolCallReduction = ((without.tool_calls - with_.tool_calls) / without.tool_calls) * 100;
	const fileReadReduction = ((without.files_read - with_.files_read) / without.files_read) * 100;

	// Create comparison table
	console.log('\n┌─────────────────────┬──────────────┬──────────────┬─────────────┐');
	console.log('│                     │ WITHOUT      │ WITH         │ IMPROVEMENT │');
	console.log('│                     │ osgrep       │ osgrep       │             │');
	console.log('├─────────────────────┼──────────────┼──────────────┼─────────────┤');
	
	console.log(`│ Time                │ ${formatDuration(without.duration_ms).padEnd(12)} │ ${formatDuration(with_.duration_ms).padEnd(12)} │ ${formatImprovement(timeImprovement, 'x faster').padEnd(11)} │`);
	console.log(`│ Cost                │ ${formatCost(without.cost_usd).padEnd(12)} │ ${formatCost(with_.cost_usd).padEnd(12)} │ ${formatPercent(costSavings, 'cheaper').padEnd(11)} │`);
	console.log(`│ Input Tokens        │ ${formatNumber(without.input_tokens).padEnd(12)} │ ${formatNumber(with_.input_tokens).padEnd(12)} │ ${formatPercent(tokenReduction, 'less').padEnd(11)} │`);
	console.log(`│ Output Tokens       │ ${formatNumber(without.output_tokens).padEnd(12)} │ ${formatNumber(with_.output_tokens).padEnd(12)} │ ${formatDiff(without.output_tokens, with_.output_tokens).padEnd(11)} │`);
	console.log(`│ Tool Calls          │ ${formatNumber(without.tool_calls).padEnd(12)} │ ${formatNumber(with_.tool_calls).padEnd(12)} │ ${formatPercent(toolCallReduction, 'less').padEnd(11)} │`);
	console.log(`│ Files Read          │ ${formatNumber(without.files_read).padEnd(12)} │ ${formatNumber(with_.files_read).padEnd(12)} │ ${formatPercent(fileReadReduction, 'less').padEnd(11)} │`);
	
	console.log('└─────────────────────┴──────────────┴──────────────┴─────────────┘');

	// Summary
	console.log(chalk.bold('\n💡 Summary'));
	console.log(chalk.dim('─'.repeat(60)));
	
	if (timeImprovement > 1.5) {
		console.log(chalk.green(`✓ osgrep is ${timeImprovement.toFixed(1)}x faster`));
	}
	
	if (costSavings > 30) {
		console.log(chalk.green(`✓ osgrep saves ${costSavings.toFixed(0)}% in cost`));
	}
	
	if (tokenReduction > 50) {
		console.log(chalk.green(`✓ osgrep reduces input tokens by ${tokenReduction.toFixed(0)}%`));
	}

	console.log(chalk.dim('─'.repeat(60)));
}

// Formatting helpers
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(usd: number): string {
	return `$${usd.toFixed(4)}`;
}

function formatNumber(n: number): string {
	return n.toLocaleString();
}

function formatImprovement(ratio: number, suffix: string): string {
	return `${ratio.toFixed(1)}${suffix}`;
}

function formatPercent(percent: number, suffix: string): string {
	if (percent < 0) return 'N/A';
	return `${percent.toFixed(0)}% ${suffix}`;
}

function formatDiff(before: number, after: number): string {
	const diff = ((after - before) / before) * 100;
	if (Math.abs(diff) < 1) return 'similar';
	return diff > 0 ? `+${diff.toFixed(0)}%` : `${diff.toFixed(0)}%`;
}

// Main execution
async function main() {
	const question = process.argv[2];
	const repoPath = process.argv[3] || process.cwd();

	if (!question) {
		console.error(chalk.red('Usage: benchmark-agent <question> [repo-path]'));
		console.error(chalk.dim('Example: benchmark-agent "How does authentication work?" ./my-repo'));
		process.exit(1);
	}

	if (!process.env.ANTHROPIC_API_KEY) {
		console.error(chalk.red('Error: ANTHROPIC_API_KEY environment variable not set'));
		process.exit(1);
	}

	try {
		const comparison = await runBenchmark(question, repoPath);
		displayResults(comparison);
	} catch (error) {
		console.error(chalk.red('Benchmark failed:'), error);
		process.exit(1);
	}
}

if (require.main === module) {
	main();
}

export { runBenchmark, displayResults };

