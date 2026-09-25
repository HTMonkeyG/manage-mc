const path = require("path");
const webpack = require("webpack");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = {
  entry: "./src/main.js",
  target: "node",
  output: {
    filename: "cli.js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
  },
  plugins: [
    new webpack.BannerPlugin({
      banner: "#!/usr/bin/env node",
      raw: true,
      entryOnly: true,
    }),
  ],
  mode: "production",
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false
      }),
    ],
  },
  externals: [
    ({ request }, callback) => {
      if (!request) return callback();
      if (request.startsWith(".") || path.isAbsolute(request)) {
        return callback();
      }
      callback(null, "commonjs " + request);
    },
  ],
  externalsPresets: { node: true },
};