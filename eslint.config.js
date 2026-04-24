import config from "@echristian/eslint-config"

export default [
  ...config({
    prettier: {
      singleQuote: false,
      plugins: ["prettier-plugin-packagejson"],
    },
  }),
  {
    rules: {
      "max-lines-per-function": "off",
    },
  },
]
