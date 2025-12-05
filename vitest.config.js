Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("vitest/config");
exports.default = config_1.defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
});
//# sourceMappingURL=vitest.config.js.map
