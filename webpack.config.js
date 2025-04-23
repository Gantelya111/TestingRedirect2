import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: 'development',
  entry: {
    'p2p-app': './src/p2p-app-src.js',
    'manager': './src/manager-src.js',
    'edit-redirect': './src/edit-redirect-src.js',
    'p2p': './src/p2p.js',
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'public'),
    publicPath: '/',
    library: {
      type: 'module',
    },
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', {
                targets: 'defaults',
                modules: false, // Зберігаємо ESM
              }],
            ],
            sourceType: 'module', // Явно вказуємо, що код є ESM
          },
        },
      },
    ],
  },
  resolve: {
    extensions: ['.js'],
    fallback: {
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      buffer: 'buffer',
      assert: 'assert',
      process: 'process/browser.js',
      util: 'util',
      url: 'url',
      path: 'path-browserify',
      os: 'os-browserify/browser.js',
      https: 'https-browserify',
      http: 'stream-http',
      vm: 'vm-browserify',
    },
    alias: {
      'node:crypto': 'crypto',
    },
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser.js',
    }),
    new BundleAnalyzerPlugin({
      analyzerMode: 'static',
      openAnalyzer: false,
      reportFilename: 'report.html',
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/html', to: '.' },
        { from: 'src/html/favicon.ico', to: 'favicon.ico' },
      ],
    }),
  ],
  devtool: 'source-map',
  performance: {
    hints: false,
  },
  stats: 'verbose',
  cache: false,
  target: 'web',
  experiments: {
    outputModule: true, // Увімкнення підтримки ESM
  },
};