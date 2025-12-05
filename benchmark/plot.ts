#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

interface BenchmarkRow {
  query: string;
  baselineTime: number;
  baselineCost: number;
  osgrepTime: number;
  osgrepCost: number;
  winner: "baseline" | "osgrep" | "tie";
}

interface CumulativeData {
  totalBaselineTime: number;
  totalOsgrepTime: number;
  totalBaselineCost: number;
  totalOsgrepCost: number;
  queryCount: number;
  osgrepWins: number;
  baselineWins: number;
  ties: number;
}

function parseCSV(csvPath: string): BenchmarkRow[] {
  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const rows: BenchmarkRow[] = [];

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 6) continue;

    rows.push({
      query: parts[0],
      baselineTime: parseFloat(parts[1]) || 0,
      baselineCost: parseFloat(parts[2]) || 0,
      osgrepTime: parseFloat(parts[3]) || 0,
      osgrepCost: parseFloat(parts[4]) || 0,
      winner: (parts[5]?.toLowerCase() || "tie") as
        | "baseline"
        | "osgrep"
        | "tie",
    });
  }

  return rows;
}

function calculateCumulative(rows: BenchmarkRow[]): CumulativeData {
  return rows.reduce(
    (acc, row) => ({
      totalBaselineTime: acc.totalBaselineTime + row.baselineTime,
      totalOsgrepTime: acc.totalOsgrepTime + row.osgrepTime,
      totalBaselineCost: acc.totalBaselineCost + row.baselineCost,
      totalOsgrepCost: acc.totalOsgrepCost + row.osgrepCost,
      queryCount: acc.queryCount + 1,
      osgrepWins: acc.osgrepWins + (row.winner === "osgrep" ? 1 : 0),
      baselineWins: acc.baselineWins + (row.winner === "baseline" ? 1 : 0),
      ties: acc.ties + (row.winner === "tie" ? 1 : 0),
    }),
    {
      totalBaselineTime: 0,
      totalOsgrepTime: 0,
      totalBaselineCost: 0,
      totalOsgrepCost: 0,
      queryCount: 0,
      osgrepWins: 0,
      baselineWins: 0,
      ties: 0,
    },
  );
}

function generateHTML(cumulative: CumulativeData): string {
  const avgBaselineTime = cumulative.totalBaselineTime / cumulative.queryCount;
  const avgOsgrepTime = cumulative.totalOsgrepTime / cumulative.queryCount;
  const avgBaselineCost = cumulative.totalBaselineCost / cumulative.queryCount;
  const avgOsgrepCost = cumulative.totalOsgrepCost / cumulative.queryCount;

  const timeImprovement = (
    ((avgBaselineTime - avgOsgrepTime) / avgBaselineTime) *
    100
  ).toFixed(1);
  const costImprovement = (
    ((avgBaselineCost - avgOsgrepCost) / avgBaselineCost) *
    100
  ).toFixed(1);
  const osgrepWinRate = (
    (cumulative.osgrepWins / cumulative.queryCount) *
    100
  ).toFixed(0);

  const maxTime = Math.max(avgBaselineTime, avgOsgrepTime);
  const maxCost = Math.max(avgBaselineCost, avgOsgrepCost);
  const maxWins = Math.max(
    cumulative.osgrepWins,
    cumulative.baselineWins,
    cumulative.ties,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>osgrep Benchmark Results</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'IBM Plex Mono', 'SF Mono', 'Consolas', monospace;
      background: #ffffff;
      min-height: 100vh;
      padding: 60px 40px;
      color: #1a3d1a;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    .header {
      text-align: center;
      margin-bottom: 80px;
    }

    .header h1 {
      font-size: 64px;
      font-weight: 700;
      color: #1a3d1a;
      margin-bottom: 16px;
      letter-spacing: -0.03em;
    }

    .header p {
      font-size: 20px;
      color: #4a6b4a;
      font-weight: 400;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 32px;
      margin-bottom: 80px;
    }

    .stat-card {
      background: #f8faf8;
      border-radius: 24px;
      padding: 40px;
      border: 2px solid #e8f0e8;
      transition: transform 0.2s ease;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }

    .stat-card:hover {
      transform: translateY(-5px);
      border-color: #2d5a2d;
    }

    .stat-label {
      font-size: 16px;
      color: #6b8a6b;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 24px;
      font-weight: 600;
    }

    .stat-number {
      font-size: 48px;
      font-weight: 700;
      color: #1a3d1a;
      line-height: 1;
      margin-bottom: 8px;
    }

    .stat-sub {
      font-size: 18px;
      color: #4a6b4a;
      margin-bottom: 24px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 8px 16px;
      background: #1a6f1a;
      color: white;
      border-radius: 100px;
      font-size: 16px;
      font-weight: 600;
    }

    .badge.neutral {
      background: #6b8a6b;
    }

    .charts-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 40px;
      align-items: stretch;
    }

    .chart-section {
      background: white;
      display: flex;
      flex-direction: column;
    }

    .chart-title {
      font-size: 24px;
      font-weight: 700;
      color: #1a3d1a;
      margin-bottom: 40px;
      text-align: center;
      letter-spacing: -0.01em;
    }

    .bar-chart {
      display: flex;
      justify-content: center;
      align-items: flex-end;
      height: 400px;
      gap: 40px;
      padding-bottom: 60px;
      position: relative;
      border-bottom: 2px solid #e8f0e8;
    }

    .bar-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      height: 100%;
      width: 80px;
      position: relative;
    }

    .bar-value {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 12px;
      color: #1a3d1a;
    }

    .bar {
      width: 100%;
      border-radius: 8px 8px 0 0;
      transition: height 1.5s cubic-bezier(0.2, 0.8, 0.2, 1);
      position: relative;
    }

    .bar.baseline {
      background: #e0e8e0;
    }

    .bar.osgrep {
      background: #1a6f1a;
    }

    .bar.tie {
      background: #8aa88a;
    }

    .bar-label {
      position: absolute;
      bottom: -40px;
      font-size: 16px;
      font-weight: 600;
      color: #4a6b4a;
      text-align: center;
      width: 140px;
      left: 50%;
      transform: translateX(-50%);
    }

    .footer {
      text-align: center;
      margin-top: 80px;
      padding-top: 32px;
      color: #8aa88a;
      font-size: 16px;
    }

    .footer a {
      color: #2d5a2d;
      text-decoration: none;
      font-weight: 700;
    }

    .footer a:hover {
      text-decoration: underline;
    }

    @media (max-width: 1100px) {
      .stats-grid, .charts-grid {
        grid-template-columns: 1fr;
        gap: 40px;
      }
      
      .bar-chart {
        height: 300px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>osgrep benchmark</h1>
      <p>Cumulative performance across ${cumulative.queryCount} queries</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Time</div>
        <div class="stat-number">${Math.floor(cumulative.totalOsgrepTime / 60)}m ${(cumulative.totalOsgrepTime % 60).toFixed(0)}s</div>
        <div class="stat-sub">vs ${Math.floor(cumulative.totalBaselineTime / 60)}m ${(cumulative.totalBaselineTime % 60).toFixed(0)}s baseline</div>
        <div class="badge">${timeImprovement}% faster</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Total Cost</div>
        <div class="stat-number">$${cumulative.totalOsgrepCost.toFixed(2)}</div>
        <div class="stat-sub">vs $${cumulative.totalBaselineCost.toFixed(2)} baseline</div>
        <div class="badge ${parseFloat(costImprovement) < 0 ? "neutral" : ""}">
          ${parseFloat(costImprovement) >= 0 ? `${costImprovement}% cheaper` : `${Math.abs(parseFloat(costImprovement)).toFixed(1)}% more`}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-number">${osgrepWinRate}%</div>
        <div class="stat-sub">${cumulative.osgrepWins} wins, ${cumulative.baselineWins} losses</div>
        <div class="badge">Preferred</div>
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-section">
        <div class="chart-title">Avg Time per Query</div>
        <div class="bar-chart">
          <div class="bar-col">
            <div class="bar-value">${avgBaselineTime.toFixed(1)}s</div>
            <div class="bar baseline" style="height: ${((avgBaselineTime / maxTime) * 100).toFixed(1)}%"></div>
            <div class="bar-label">Baseline</div>
          </div>
          <div class="bar-col">
            <div class="bar-value">${avgOsgrepTime.toFixed(1)}s</div>
            <div class="bar osgrep" style="height: ${((avgOsgrepTime / maxTime) * 100).toFixed(1)}%"></div>
            <div class="bar-label">osgrep</div>
          </div>
        </div>
      </div>

      <div class="chart-section">
        <div class="chart-title">Avg Cost per Query</div>
        <div class="bar-chart">
          <div class="bar-col">
            <div class="bar-value">$${avgBaselineCost.toFixed(3)}</div>
            <div class="bar baseline" style="height: ${((avgBaselineCost / maxCost) * 100).toFixed(1)}%"></div>
            <div class="bar-label">Baseline</div>
          </div>
          <div class="bar-col">
            <div class="bar-value">$${avgOsgrepCost.toFixed(3)}</div>
            <div class="bar osgrep" style="height: ${((avgOsgrepCost / maxCost) * 100).toFixed(1)}%"></div>
            <div class="bar-label">osgrep</div>
          </div>
        </div>
      </div>

      <div class="chart-section">
        <div class="chart-title">LLM Preference</div>
        <div class="bar-chart">
          <div class="bar-col">
            <div class="bar-value">${cumulative.baselineWins}</div>
            <div class="bar baseline" style="height: ${((cumulative.baselineWins / maxWins) * 100).toFixed(1)}%"></div>
            <div class="bar-label">Baseline</div>
          </div>
          ${
            cumulative.ties > 0
              ? `
          <div class="bar-col">
            <div class="bar-value">${cumulative.ties}</div>
            <div class="bar tie" style="height: ${((cumulative.ties / maxWins) * 100).toFixed(1)}%"></div>
            <div class="bar-label">Ties</div>
          </div>`
              : ""
          }
          <div class="bar-col">
            <div class="bar-value">${cumulative.osgrepWins}</div>
            <div class="bar osgrep" style="height: ${((cumulative.osgrepWins / maxWins) * 100).toFixed(1)}%"></div>
            <div class="bar-label">osgrep</div>
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>Generated with <a href="https://github.com/yourusername/osgrep" target="_blank">osgrep</a> benchmark tool</p>
    </div>
  </div>
</body>
</html>`;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: ts-node generate-benchmark.ts <path-to-csv>");
    console.error("");
    console.error("CSV format:");
    console.error(
      "Query,Baseline Time (s),Baseline Cost ($),osgrep Time (s),osgrep Cost ($),Winner",
    );
    process.exit(1);
  }

  const csvPath = args[0];

  if (!fs.existsSync(csvPath)) {
    console.error(`Error: File not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading benchmark data from: ${csvPath}`);
  const rows = parseCSV(csvPath);
  console.log(`Parsed ${rows.length} benchmark queries`);

  const cumulative = calculateCumulative(rows);
  console.log("Calculating cumulative metrics...");

  // Calculate averages for logging
  const avgBaselineTime = cumulative.totalBaselineTime / cumulative.queryCount;
  const avgOsgrepTime = cumulative.totalOsgrepTime / cumulative.queryCount;
  const avgBaselineCost = cumulative.totalBaselineCost / cumulative.queryCount;
  const avgOsgrepCost = cumulative.totalOsgrepCost / cumulative.queryCount;

  const html = generateHTML(cumulative);

  const outputPath = path.join(path.dirname(csvPath), "benchmark-results.html");
  fs.writeFileSync(outputPath, html, "utf-8");

  console.log(`✓ Benchmark visualization generated: ${outputPath}`);
  console.log("");
  console.log("Summary:");
  console.log(`  Queries: ${cumulative.queryCount}`);
  console.log(
    `  Avg time improvement: ${(((avgBaselineTime - avgOsgrepTime) / avgBaselineTime) * 100).toFixed(1)}%`,
  );
  console.log(
    `  Avg cost change: ${(((avgBaselineCost - avgOsgrepCost) / avgBaselineCost) * 100).toFixed(1)}%`,
  );
  console.log(
    `  osgrep wins: ${cumulative.osgrepWins}/${cumulative.queryCount} (${((cumulative.osgrepWins / cumulative.queryCount) * 100).toFixed(0)}%)`,
  );
}

main();
