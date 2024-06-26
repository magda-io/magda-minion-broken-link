const config = {
    tabWidth: 4,
    singleQuote: false,
    printWidth: 80,
    trailingComma: "none",
    useTabs: false,
    overrides: [
        {
            files: ["**/package.json", "lerna.json"],
            options: {
                tabWidth: 2
            }
        },
        {
            files: [
                "**/*.yml",
                "**/*.yaml",
                "**/.*.yaml",
                "**/.*.yml",
                "**/*.yaml"
            ],
            options: {
                tabWidth: 2
            }
        }
    ]
};

export default config;
