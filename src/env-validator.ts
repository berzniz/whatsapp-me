import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

interface EnvVariable {
	name: string;
	required: boolean;
	description: string;
	defaultValue?: string;
}

const ENV_VARIABLES: EnvVariable[] = [
	{
		name: "OPENAI_API_KEY",
		required: true,
		description: "OpenAI API key for event detection",
	},
	{
		name: "OPENAI_TIMEOUT_MS",
		required: false,
		description: "OpenAI API timeout in milliseconds",
		defaultValue: "30000",
	},
	{
		name: "ALLOWED_CHAT_NAMES",
		required: false,
		description: "Comma-separated list of allowed chat names to analyze",
	},
	{
		name: "TARGET_GROUP_ID",
		required: false,
		description: "WhatsApp group ID where event summaries will be sent",
	},
	{
		name: "TARGET_GROUP_NAME",
		required: false,
		description:
			"WhatsApp group name to search for (if TARGET_GROUP_ID is not set)",
	},
	{
		name: "BOT_GROUP_ID",
		required: false,
		description: "WhatsApp bot group ID",
	},
	{
		name: "BOT_GROUP_NAME",
		required: false,
		description: "WhatsApp bot group name (for searching)",
	},
	{
		name: "EVENT_DEDUPLICATION_TTL_HOURS",
		required: false,
		description: "Event deduplication cache TTL in hours",
		defaultValue: "24",
	},
];

export class EnvValidator {
	private envFilePath: string;

	constructor() {
		this.envFilePath = path.join(process.cwd(), ".env");
	}

	/**
	 * Read existing .env file and parse it into a Map
	 */
	private readEnvFile(): Map<string, string> {
		const envMap = new Map<string, string>();

		if (fs.existsSync(this.envFilePath)) {
			const content = fs.readFileSync(this.envFilePath, "utf-8");
			const lines = content.split("\n");

			for (const line of lines) {
				const trimmed = line.trim();
				// Skip empty lines and comments
				if (!trimmed || trimmed.startsWith("#")) {
					continue;
				}

				const equalIndex = trimmed.indexOf("=");
				if (equalIndex > 0) {
					const key = trimmed.substring(0, equalIndex).trim();
					const value = trimmed.substring(equalIndex + 1).trim();
					envMap.set(key, value);
				}
			}
		}

		return envMap;
	}

	/**
	 * Write environment variables to .env file
	 */
	private writeEnvFile(envMap: Map<string, string>): void {
		const lines: string[] = [];
		const writtenKeys = new Set<string>();

		// Write variables in the order they're defined
		for (const envVar of ENV_VARIABLES) {
			const value = envMap.get(envVar.name);
			if (value !== undefined) {
				lines.push(`${envVar.name}=${value}`);
				writtenKeys.add(envVar.name);
			}
		}

		// Write any other variables that were in the original file but not in our list
		for (const [key, value] of envMap.entries()) {
			if (!writtenKeys.has(key)) {
				lines.push(`${key}=${value}`);
			}
		}

		fs.writeFileSync(this.envFilePath, lines.join("\n") + "\n", "utf-8");
	}

	/**
	 * Prompt user for input
	 */
	private async promptUser(question: string): Promise<string> {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		return new Promise((resolve) => {
			rl.question(question, (answer) => {
				rl.close();
				resolve(answer.trim());
			});
		});
	}

	/**
	 * Display all environment variables and their status
	 */
	private displayEnvStatus(envMap: Map<string, string>): void {
		console.log("\nEnvironment Variables Status:");
		console.log("=".repeat(50));

		for (const envVar of ENV_VARIABLES) {
			const value = envMap.get(envVar.name) || process.env[envVar.name];
			const status = value
				? "✓ Set"
				: envVar.required
					? "✗ Missing (Required)"
					: "○ Optional";
			const displayValue = value
				? envVar.name === "OPENAI_API_KEY"
					? `${value.substring(0, 8)}...` // Mask API key
					: value
				: envVar.defaultValue
					? `(default: ${envVar.defaultValue})`
					: "";

			console.log(
				`${status.padEnd(20)} ${envVar.name.padEnd(35)} ${displayValue}`,
			);
			if (envVar.description) {
				console.log(`  ${" ".repeat(20)} ${envVar.description}`);
			}
		}

		console.log("=".repeat(50));
	}

	/**
	 * Validate and ensure all required environment variables are set
	 */
	public async validateAndPrompt(): Promise<void> {
		// Load existing .env file
		const envMap = this.readEnvFile();

		// Also check process.env for variables that might be set externally
		for (const envVar of ENV_VARIABLES) {
			const envValue = process.env[envVar.name];
			if (!envMap.has(envVar.name) && envValue) {
				envMap.set(envVar.name, envValue);
			}
		}

		// Display current status
		this.displayEnvStatus(envMap);

		// Check for missing required variables
		const missingRequired: EnvVariable[] = [];
		for (const envVar of ENV_VARIABLES) {
			if (envVar.required) {
				const value = envMap.get(envVar.name) || process.env[envVar.name];
				if (!value) {
					missingRequired.push(envVar);
				}
			}
		}

		// Prompt for missing required variables
		if (missingRequired.length > 0) {
			console.log("\n⚠️  Missing required environment variables:");
			for (const envVar of missingRequired) {
				console.log(`  - ${envVar.name}: ${envVar.description}`);
			}
			console.log("\nPlease provide the missing values:\n");

			for (const envVar of missingRequired) {
				const prompt = `${envVar.name}${envVar.description ? ` (${envVar.description})` : ""}: `;
				let value = await this.promptUser(prompt);

				// Use default value if provided and user didn't enter anything
				if (!value && envVar.defaultValue) {
					value = envVar.defaultValue;
					console.log(`  Using default value: ${envVar.defaultValue}`);
				}

				if (value) {
					envMap.set(envVar.name, value);
				}
			}

			// Write updated .env file
			this.writeEnvFile(envMap);
			console.log(`\n✓ Updated .env file: ${this.envFilePath}`);

			// Reload dotenv to pick up new values
			const dotenv = await import("dotenv");
			dotenv.config();
		} else {
			console.log("\n✓ All required environment variables are set!");
		}

		// Verify all required variables are now set
		for (const envVar of ENV_VARIABLES) {
			if (envVar.required) {
				const value = envMap.get(envVar.name) || process.env[envVar.name];
				if (!value) {
					throw new Error(
						`Required environment variable ${envVar.name} is still not set`,
					);
				}
			}
		}
	}
}
