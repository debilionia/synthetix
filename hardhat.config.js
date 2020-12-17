'use strict';

const path = require('path');

require('./hardhat');
require('@nomiclabs/hardhat-truffle5'); // uses and exposes web3 via hardhat-web3 plugin
// require('@eth-optimism/ovm-toolchain/build/src/buidler-plugins/buidler-ovm-compiler'); // enable custom solc compiler
// require('@eth-optimism/ovm-toolchain/build/src/buidler-plugins/buidler-ovm-node'); // add ability to start an OVM node
require('solidity-coverage');
require('hardhat-gas-reporter');
// usePlugin('buidler-ast-doc'); // compile ASTs for use with synthetix-docs

const {
	constants: { inflationStartTimestampInSecs, AST_FILENAME, AST_FOLDER, BUILD_FOLDER },
} = require('.');

const GAS_PRICE = 20e9; // 20 GWEI
const CACHE_FOLDER = 'cache';

module.exports = {
	GAS_PRICE,
	solidity: {
		compilers: [
			{
				version: '0.4.25',
			},
			{
				version: '0.5.16',
			},
		],
	},
	paths: {
		sources: './contracts',
		tests: './test/contracts',
		artifacts: path.join(BUILD_FOLDER, 'artifacts'),
		cache: path.join(BUILD_FOLDER, CACHE_FOLDER),
	},
	astdocs: {
		path: path.join(BUILD_FOLDER, AST_FOLDER),
		file: AST_FILENAME,
		ignores: 'test-helpers',
	},
	defaultNetwork: 'hardhat',
	networks: {
		hardhat: {
			blockGasLimit: 12000000,
			initialDate: new Date(inflationStartTimestampInSecs * 1000).toISOString(),
			gasPrice: GAS_PRICE,
			allowUnlimitedContractSize: true,
			forking: {
				// blockNumber: 11471344, // Uncomment to fix on a block for faster prod test development
				url:
					process.env.PROVIDER_URL_MAINNET ||
					process.env.PROVIDER_URL.replace('network', 'mainnet'),
				enabled: false,
			},
		},
	},
	gasReporter: {
		enabled: false,
		showTimeSpent: true,
		currency: 'USD',
		maxMethodDiff: 25, // CI will fail if gas usage is > than this %
		outputFile: 'test-gas-used.log',
	},
};
