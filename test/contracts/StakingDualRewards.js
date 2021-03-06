const { contract } = require('hardhat');
const { toBN } = require('web3-utils');

const { toBytes32 } = require('../..');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { mockToken, setupAllContracts, setupContract } = require('./setup');
const { currentTime, toUnit, fastForward } = require('../utils')();

contract('StakingDualRewards', accounts => {
	const [
		,
		owner,
		oracle,
		authority,
		rewardEscrowAddress,
		stakingAccount1,
		mockRewardsDistributionAddress,
	] = accounts;

	// Synthetix is the rewardsTokenA
	let rewardsTokenA,
		rewardsTokenB,
		stakingToken,
		externalRewardsToken,
		exchangeRates,
		stakingDualRewards,
		rewardsDistribution,
		systemSettings,
		feePool;

	const DAY = 86400;
	const ZERO_BN = toBN(0);

	const setRewardsTokenExchangeRate = async ({ rateStaleDays } = { rateStaleDays: 7 }) => {
		const rewardsTokenAIdentifier = await rewardsTokenA.symbol();

		await systemSettings.setRateStalePeriod(DAY * rateStaleDays, { from: owner });
		const updatedTime = await currentTime();
		await exchangeRates.updateRates(
			[toBytes32(rewardsTokenAIdentifier)],
			[toUnit('2')],
			updatedTime,
			{
				from: oracle,
			}
		);
		assert.equal(await exchangeRates.rateIsStale(toBytes32(rewardsTokenAIdentifier)), false);
	};

	addSnapshotBeforeRestoreAfterEach();

	before(async () => {
		({ token: stakingToken } = await mockToken({
			accounts,
			name: 'Staking Token',
			symbol: 'STKN',
		}));

		({ token: rewardsTokenB } = await mockToken({
			accounts,
			name: 'dHEDGE DAO',
			symbol: 'DHT',
		}));

		({ token: externalRewardsToken } = await mockToken({
			accounts,
			name: 'External Rewards Token',
			symbol: 'MOAR',
		}));

		({
			RewardsDistribution: rewardsDistribution,
			FeePool: feePool,
			Synthetix: rewardsTokenA,
			ExchangeRates: exchangeRates,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			contracts: ['RewardsDistribution', 'Synthetix', 'FeePool', 'SystemSettings'],
		}));

		stakingDualRewards = await setupContract({
			accounts,
			contract: 'StakingDualRewards',
			args: [
				owner,
				rewardsDistribution.address,
				rewardsTokenA.address,
				rewardsTokenB.address,
				stakingToken.address,
			],
		});

		await Promise.all([
			rewardsDistribution.setAuthority(authority, { from: owner }),
			rewardsDistribution.setRewardEscrow(rewardEscrowAddress, { from: owner }),
			rewardsDistribution.setSynthetixProxy(rewardsTokenA.address, { from: owner }),
			rewardsDistribution.setFeePoolProxy(feePool.address, { from: owner }),
		]);

		await stakingDualRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
			from: owner,
		});
		await setRewardsTokenExchangeRate();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: stakingDualRewards.abi,
			ignoreParents: ['ReentrancyGuard', 'Owned'],
			expected: [
				'stake',
				'withdraw',
				'exit',
				'getReward',
				'notifyRewardAmount',
				'setPaused',
				'setRewardsDistribution',
				'setRewardsDuration',
				'recoverERC20',
				'updatePeriodFinish',
			],
		});
	});

	describe('Constructor & Settings', () => {
		it('should set rewards token on constructor', async () => {
			console.log('running should set rewards token on constructor');
			assert.equal(await stakingDualRewards.rewardsTokenA(), rewardsTokenA.address);
		});

		it('should staking token on constructor', async () => {
			console.log('running should staking token on constructor');
			assert.equal(await stakingDualRewards.stakingToken(), stakingToken.address);
		});

		it('should set owner on constructor', async () => {
			const ownerAddress = await stakingDualRewards.owner();
			assert.equal(ownerAddress, owner);
		});
	});

	describe('Function permissions', () => {
		const rewardValue = toUnit(1.0);

		before(async () => {
			await rewardsTokenA.transfer(stakingDualRewards.address, rewardValue, { from: owner });
		});

		it('only owner can call notifyRewardAmount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: stakingDualRewards.notifyRewardAmount,
				args: [rewardValue, 0],
				address: mockRewardsDistributionAddress,
				accounts,
			});
		});

		it('only rewardsDistribution address can call notifyRewardAmount', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: stakingDualRewards.notifyRewardAmount,
				args: [rewardValue, 0],
				address: mockRewardsDistributionAddress,
				accounts,
			});
		});

		it('only owner address can call setRewardsDuration', async () => {
			await fastForward(DAY * 7);
			await onlyGivenAddressCanInvoke({
				fnc: stakingDualRewards.setRewardsDuration,
				args: [70],
				address: owner,
				accounts,
			});
		});

		it('only owner address can call setPaused', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: stakingDualRewards.setPaused,
				args: [true],
				address: owner,
				accounts,
			});
		});

		it('only owner can call updatePeriodFinish', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: stakingDualRewards.updatePeriodFinish,
				args: [0],
				address: owner,
				accounts,
			});
		});
	});

	describe('Pausable', async () => {
		beforeEach(async () => {
			await stakingDualRewards.setPaused(true, { from: owner });
		});
		it('should revert calling stake() when paused', async () => {
			const totalToStake = toUnit('100');
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });

			await assert.revert(
				stakingDualRewards.stake(totalToStake, { from: stakingAccount1 }),
				'This action cannot be performed while the contract is paused'
			);
		});
		it('should not revert calling stake() when unpaused', async () => {
			await stakingDualRewards.setPaused(false, { from: owner });

			const totalToStake = toUnit('100');
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });

			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });
		});
	});

	describe('External Rewards Recovery', () => {
		const amount = toUnit('5000');
		beforeEach(async () => {
			// Send ERC20 to StakingRewards Contract
			await externalRewardsToken.transfer(stakingDualRewards.address, amount, { from: owner });
			assert.bnEqual(await externalRewardsToken.balanceOf(stakingDualRewards.address), amount);
		});
		it('only owner can call recoverERC20', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: stakingDualRewards.recoverERC20,
				args: [externalRewardsToken.address, amount],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
		});
		it('should revert if recovering staking token', async () => {
			await assert.revert(
				stakingDualRewards.recoverERC20(stakingToken.address, amount, {
					from: owner,
				}),
				'Cannot withdraw the staking token'
			);
		});
		it('should retrieve external token from StakingRewards and reduce contracts balance', async () => {
			await stakingDualRewards.recoverERC20(externalRewardsToken.address, amount, {
				from: owner,
			});
			assert.bnEqual(await externalRewardsToken.balanceOf(stakingDualRewards.address), ZERO_BN);
		});
		it('should retrieve external token from StakingRewards and increase owners balance', async () => {
			const ownerMOARBalanceBefore = await externalRewardsToken.balanceOf(owner);

			await stakingDualRewards.recoverERC20(externalRewardsToken.address, amount, {
				from: owner,
			});

			const ownerMOARBalanceAfter = await externalRewardsToken.balanceOf(owner);
			assert.bnEqual(ownerMOARBalanceAfter.sub(ownerMOARBalanceBefore), amount);
		});
		it('should emit Recovered event', async () => {
			const transaction = await stakingDualRewards.recoverERC20(externalRewardsToken.address, amount, {
				from: owner,
			});
			assert.eventEqual(transaction, 'Recovered', {
				token: externalRewardsToken.address,
				amount: amount,
			});
		});
	});

	describe('lastTimeRewardApplicable()', () => {
		it('should return 0', async () => {
			assert.bnEqual(await stakingDualRewards.lastTimeRewardApplicable(), ZERO_BN);
		});

		describe('when updated', () => {
			it('should equal current timestamp', async () => {
				await stakingDualRewards.notifyRewardAmount(toUnit(1.0), 0, {
					from: mockRewardsDistributionAddress,
				});

				const cur = await currentTime();
				const lastTimeReward = await stakingDualRewards.lastTimeRewardApplicable();

				assert.equal(cur.toString(), lastTimeReward.toString());
			});
		});
	});

	describe('rewardPerToken()', () => {
		it('should return 0', async () => {
			assert.bnEqual(await stakingDualRewards.rewardPerTokenA(), ZERO_BN);
		});

		it('should be > 0', async () => {
			const totalToStake = toUnit('100');
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			const totalSupply = await stakingDualRewards.totalSupply();
			assert.bnGt(totalSupply, ZERO_BN);

			const rewardValue = toUnit(5000.0);
			await rewardsTokenA.transfer(stakingDualRewards.address, rewardValue, { from: owner });
			await stakingDualRewards.notifyRewardAmount(rewardValue, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			const rewardPerToken = await stakingDualRewards.rewardPerTokenA();
			assert.bnGt(rewardPerToken, ZERO_BN);
		});
	});

	describe('stake()', () => {
		it('staking increases staking balance', async () => {
			const totalToStake = toUnit('100');
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });

			const initialStakeBal = await stakingDualRewards.balanceOf(stakingAccount1);
			const initialLpBal = await stakingToken.balanceOf(stakingAccount1);

			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			const postStakeBal = await stakingDualRewards.balanceOf(stakingAccount1);
			const postLpBal = await stakingToken.balanceOf(stakingAccount1);

			assert.bnLt(postLpBal, initialLpBal);
			assert.bnGt(postStakeBal, initialStakeBal);
		});

		it('cannot stake 0', async () => {
			await assert.revert(stakingDualRewards.stake('0'), 'Cannot stake 0');
		});
	});

	describe('earned()', () => {
		it('should be 0 when not staking', async () => {
			assert.bnEqual(await stakingDualRewards.earnedA(stakingAccount1), ZERO_BN);
		});

		it('should be > 0 when staking', async () => {
			const totalToStake = toUnit('100');
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			const rewardValue = toUnit(5000.0);
			await rewardsTokenA.transfer(stakingDualRewards.address, rewardValue, { from: owner });
			await stakingDualRewards.notifyRewardAmount(rewardValue, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			const earned = await stakingDualRewards.earnedA(stakingAccount1);

			assert.bnGt(earned, ZERO_BN);
		});

		it('rewardRate should increase if new rewards come before DURATION ends', async () => {
			const totalToDistribute = toUnit('5000');

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			const rewardRateInitial = await stakingDualRewards.rewardRateA();

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			const rewardRateLater = await stakingDualRewards.rewardRateA();

			assert.bnGt(rewardRateInitial, ZERO_BN);
			assert.bnGt(rewardRateLater, rewardRateInitial);
		});

		it('rewards token balance should rollover after DURATION', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');

			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 7);

			const earnedFirst = await stakingDualRewards.earnedA(stakingAccount1);
			console.log('earnedFirst: '+ earnedFirst.toString());
			await setRewardsTokenExchangeRate();

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 7);

			const earnedSecond = await stakingDualRewards.earnedA(stakingAccount1);
			console.log('earnedSecond (After Fastforward): '+ earnedSecond.toString());
			assert.bnEqual(earnedSecond, earnedFirst.add(earnedFirst));
		});
	});

	describe('getReward()', () => {
		it('should increase rewards token balance', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');

			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			const initialRewardBal = await rewardsTokenA.balanceOf(stakingAccount1);
			const initialEarnedBal = await stakingDualRewards.earnedA(stakingAccount1);
			await stakingDualRewards.getReward({ from: stakingAccount1 });
			const postRewardBal = await rewardsTokenA.balanceOf(stakingAccount1);
			const postEarnedBal = await stakingDualRewards.earnedA(stakingAccount1);

			assert.bnLt(postEarnedBal, initialEarnedBal);
			assert.bnGte(postRewardBal, initialRewardBal);
		});
	});

	describe('setRewardsDuration()', () => {
		const sevenDays = DAY * 7;
		const seventyDays = DAY * 70;
		it('should increase rewards duration before starting distribution', async () => {
			const defaultDuration = await stakingDualRewards.rewardsDuration();
			assert.bnEqual(defaultDuration, sevenDays);

			await stakingDualRewards.setRewardsDuration(seventyDays, { from: owner });
			const newDuration = await stakingDualRewards.rewardsDuration();
			assert.bnEqual(newDuration, seventyDays);
		});
		it('should revert when setting setRewardsDuration before the period has finished', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');

			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY);

			await assert.revert(
				stakingDualRewards.setRewardsDuration(seventyDays, { from: owner }),
				'Previous rewards period must be complete before changing the duration for the new period'
			);
		});
		it('should update when setting setRewardsDuration after the period has finished', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');

			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 8);

			const transaction = await stakingDualRewards.setRewardsDuration(seventyDays, { from: owner });
			assert.eventEqual(transaction, 'RewardsDurationUpdated', {
				newDuration: seventyDays,
			});

			const newDuration = await stakingDualRewards.rewardsDuration();
			assert.bnEqual(newDuration, seventyDays);

			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});
		});

		it('should update when setting setRewardsDuration after the period has finished', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');

			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 4);
			await stakingDualRewards.getReward({ from: stakingAccount1 });
			await fastForward(DAY * 4);

			// New Rewards period much lower
			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			const transaction = await stakingDualRewards.setRewardsDuration(seventyDays, { from: owner });
			assert.eventEqual(transaction, 'RewardsDurationUpdated', {
				newDuration: seventyDays,
			});

			const newDuration = await stakingDualRewards.rewardsDuration();
			assert.bnEqual(newDuration, seventyDays);

			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			await fastForward(DAY * 71);
			await stakingDualRewards.getReward({ from: stakingAccount1 });
		});
	});

	describe('getRewardForDuration()', () => {
		it('should increase rewards token balance', async () => {
			const totalToDistribute = toUnit('5000');
			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(totalToDistribute, 0, {
				from: mockRewardsDistributionAddress,
			});

			const rewardForDuration = await stakingDualRewards.getRewardAForDuration();

			const duration = await stakingDualRewards.rewardsDuration();
			const rewardRate = await stakingDualRewards.rewardRateA();

			assert.bnGt(rewardForDuration, ZERO_BN);
			assert.bnEqual(rewardForDuration, duration.mul(rewardRate));
		});
	});

	describe('withdraw()', () => {
		it('cannot withdraw if nothing staked', async () => {
			await assert.revert(stakingDualRewards.withdraw(toUnit('100')), 'SafeMath: subtraction overflow');
		});

		it('should increases lp token balance and decreases staking balance', async () => {
			const totalToStake = toUnit('100');
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			const initialStakingTokenBal = await stakingToken.balanceOf(stakingAccount1);
			const initialStakeBal = await stakingDualRewards.balanceOf(stakingAccount1);

			await stakingDualRewards.withdraw(totalToStake, { from: stakingAccount1 });

			const postStakingTokenBal = await stakingToken.balanceOf(stakingAccount1);
			const postStakeBal = await stakingDualRewards.balanceOf(stakingAccount1);

			assert.bnEqual(postStakeBal.add(toBN(totalToStake)), initialStakeBal);
			assert.bnEqual(initialStakingTokenBal.add(toBN(totalToStake)), postStakingTokenBal);
		});

		it('cannot withdraw 0', async () => {
			await assert.revert(stakingDualRewards.withdraw('0'), 'Cannot withdraw 0');
		});
	});

	describe('updatePeriodFinish()', () => {
		const updateTimeStamp = toUnit('100');

		before(async () => {
			await stakingDualRewards.updatePeriodFinish(updateTimeStamp, {
				from: owner,
			});
		});

		it('should update periodFinish', async () => {
			const periodFinish = await stakingDualRewards.periodFinish();
			assert.bnEqual(periodFinish, updateTimeStamp);
		});

		it('should update rewardRate to zero', async () => {
			const rewardRate = await stakingDualRewards.rewardRateA();
			assert.bnEqual(rewardRate, ZERO_BN);
		});
	});

	describe('exit()', () => {
		it('should retrieve all earned and increase rewards bal', async () => {
			const totalToStake = toUnit('100');
			const totalToDistribute = toUnit('5000');
			
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			await rewardsTokenA.transfer(stakingDualRewards.address, totalToDistribute, { from: owner });
			await stakingDualRewards.notifyRewardAmount(toUnit(5000.0), 0, {
				from: mockRewardsDistributionAddress,
			});

			const initialRewardBal = await rewardsTokenA.balanceOf(stakingAccount1);
			const initialEarnedBal = await stakingDualRewards.earnedA(stakingAccount1);

			console.log('initialRewardBal: {} ', initialRewardBal)
			console.log('initialEarnedBal: {} ', initialEarnedBal)
			

			await fastForward(DAY);


			await stakingDualRewards.exit({ from: stakingAccount1 });
			const postRewardBal = await rewardsTokenA.balanceOf(stakingAccount1);
			console.log('postRewardBal: {} ', initialRewardBal)

			const postEarnedBal = await stakingDualRewards.earnedA(stakingAccount1);
			console.log('postEarnedBal: {} ', initialRewardBal)

			assert.bnLt(postEarnedBal, initialEarnedBal);
			assert.bnGt(postRewardBal, initialRewardBal);
			assert.bnEqual(postEarnedBal, ZERO_BN);
		});
	});

	describe('notifyRewardAmount()', () => {
		let localStakingRewards;

		before(async () => {
			localStakingRewards = await setupContract({
				accounts,
				contract: 'StakingDualRewards',
				args: [
					owner,
					rewardsDistribution.address,
					rewardsTokenA.address,
					rewardsTokenB.address,
					stakingToken.address,
				],
			});

			await localStakingRewards.setRewardsDistribution(mockRewardsDistributionAddress, {
				from: owner,
			});
		});

		it('Reverts if the provided reward is greater than the balance.', async () => {
			const rewardValue = toUnit(1000);
			await rewardsTokenA.transfer(localStakingRewards.address, rewardValue, { from: owner });
			await assert.revert(
				localStakingRewards.notifyRewardAmount(rewardValue.add(toUnit(0.1)), 0, {
					from: mockRewardsDistributionAddress,
				}),
				'Provided reward A too high'
			);
		});

		it('Reverts if the provided reward is greater than the balance, plus rolled-over balance.', async () => {
			const rewardValue = toUnit(1000);
			await rewardsTokenA.transfer(localStakingRewards.address, rewardValue, { from: owner });
			localStakingRewards.notifyRewardAmount(rewardValue, 0, {
				from: mockRewardsDistributionAddress,
			});
			await rewardsTokenA.transfer(localStakingRewards.address, rewardValue, { from: owner });
			// Now take into account any leftover quantity.
			await assert.revert(
				localStakingRewards.notifyRewardAmount(rewardValue.add(toUnit(0.1)), 0, {
					from: mockRewardsDistributionAddress,
				}),
				'Provided reward A too high'
			);
		});
	});

	describe('Integration Tests', () => {
		before(async () => {
			// Set rewardDistribution address
			await stakingDualRewards.setRewardsDistribution(rewardsDistribution.address, {
				from: owner,
			});
			assert.equal(await stakingDualRewards.rewardsDistribution(), rewardsDistribution.address);

			await setRewardsTokenExchangeRate();
		});

		it('stake and claim', async () => {
			// Transfer some LP Tokens to user
			const totalToStake = toUnit('500');
			await stakingToken.transfer(stakingAccount1, totalToStake, { from: owner });

			// Stake LP Tokens
			await stakingToken.approve(stakingDualRewards.address, totalToStake, { from: stakingAccount1 });
			await stakingDualRewards.stake(totalToStake, { from: stakingAccount1 });

			// Distribute some rewards
			const totalToDistribute = toUnit('35000');
			assert.equal(await rewardsDistribution.distributionsLength(), 0);
			await rewardsDistribution.addRewardDistribution(stakingDualRewards.address, totalToDistribute, {
				from: owner,
			});
			assert.equal(await rewardsDistribution.distributionsLength(), 1);

			// Transfer Rewards to the RewardsDistribution contract address
			await rewardsTokenA.transfer(rewardsDistribution.address, totalToDistribute, { from: owner });

			// Distribute Rewards called from Synthetix contract as the authority to distribute
			await rewardsDistribution.distributeRewards(totalToDistribute, {
				from: authority,
			});

			// Period finish should be ~7 days from now
			const periodFinish = await stakingDualRewards.periodFinish();
			const curTimestamp = await currentTime();
			
			console.log('periodFinish: ', periodFinish.toString());
			console.log('periodFinish-parsed: ', parseInt(periodFinish.toString(), 10));
			console.log('curTimestamp: ', curTimestamp.toString());
			console.log('curTimestamp-advanced-by-7-days: ', curTimestamp + DAY * 7);

			assert.equal(parseInt(periodFinish.toString(), 10), curTimestamp + DAY * 7);

			// Reward duration is 7 days, so we'll
			// Fastforward time by 6 days to prevent expiration
			await fastForward(DAY * 6);

			// Reward rate and reward per token
			const rewardRate = await stakingDualRewards.rewardRateA();
			assert.bnGt(rewardRate, ZERO_BN);

			const rewardPerToken = await stakingDualRewards.rewardPerTokenA();
			assert.bnGt(rewardPerToken, ZERO_BN);

			// Make sure we earned in proportion to reward per token
			const rewardRewardsEarned = await stakingDualRewards.earnedA(stakingAccount1);
			assert.bnEqual(rewardRewardsEarned, rewardPerToken.mul(totalToStake).div(toUnit(1)));

			// Make sure after withdrawing, we still have the ~amount of rewardRewards
			// The two values will be a bit different as time has "passed"
			const initialWithdraw = toUnit('100');
			await stakingDualRewards.withdraw(initialWithdraw, { from: stakingAccount1 });
			assert.bnEqual(initialWithdraw, await stakingToken.balanceOf(stakingAccount1));

			const rewardRewardsEarnedPostWithdraw = await stakingDualRewards.earnedA(stakingAccount1);
			assert.bnClose(rewardRewardsEarned, rewardRewardsEarnedPostWithdraw, toUnit('0.1'));

			// Get rewards
			const initialRewardBal = await rewardsTokenA.balanceOf(stakingAccount1);
			await stakingDualRewards.getReward({ from: stakingAccount1 });
			const postRewardRewardBal = await rewardsTokenA.balanceOf(stakingAccount1);

			assert.bnGt(postRewardRewardBal, initialRewardBal);

			// Exit
			const preExitLPBal = await stakingToken.balanceOf(stakingAccount1);
			await stakingDualRewards.exit({ from: stakingAccount1 });
			const postExitLPBal = await stakingToken.balanceOf(stakingAccount1);
			assert.bnGt(postExitLPBal, preExitLPBal);
		});
	});
});
