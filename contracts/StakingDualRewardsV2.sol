pragma solidity ^0.5.16;

import "openzeppelin-solidity-2.3.0/contracts/math/Math.sol";
import "openzeppelin-solidity-2.3.0/contracts/math/SafeMath.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/ERC20Detailed.sol";
import "openzeppelin-solidity-2.3.0/contracts/token/ERC20/SafeERC20.sol";
import "openzeppelin-solidity-2.3.0/contracts/utils/ReentrancyGuard.sol";
import "hardhat/console.sol";

// Inheritance
import "./interfaces/IStakingDualRewardsV2.sol";
import "./DualRewardsDistributionRecipientV2.sol";
import "./Pausable.sol";


contract StakingDualRewardsV2 is IStakingDualRewardsV2, DualRewardsDistributionRecipientV2, ReentrancyGuard, Pausable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    IERC20 public rewardsTokenA;
    IERC20 public stakingToken;
    uint256 public periodFinish = 0;
    uint256 public rewardRateA = 0;
    uint256 public rewardsDuration = 7 days;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenAStored;

    mapping(address => uint256) public userRewardPerTokenAPaid;
    mapping(address => uint256) public rewardsA;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    /* ========== CONSTRUCTOR ========== */

    constructor(
        address _owner,
        address _rewardsDistribution,
        address _rewardsTokenA,
        address _stakingToken
    ) public Owned(_owner) {
        rewardsTokenA = IERC20(_rewardsTokenA);
        stakingToken = IERC20(_stakingToken);
        rewardsDistribution = _rewardsDistribution;
    }

    /* ========== VIEWS ========== */

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return Math.min(block.timestamp, periodFinish);
    }

    function rewardPerTokenA() public view returns (uint256) {
        if (_totalSupply == 0) {
            return rewardPerTokenAStored;
        }
        return
            rewardPerTokenAStored.add(
                lastTimeRewardApplicable().sub(lastUpdateTime).mul(rewardRateA).mul(1e18).div(_totalSupply)
            );
    }

    function earnedA(address account) public view returns (uint256) {
        return _balances[account].mul(rewardPerTokenA().sub(userRewardPerTokenAPaid[account])).div(1e18).add(rewardsA[account]);
    }

    function getRewardAForDuration() external view returns (uint256) {
        return rewardRateA.mul(rewardsDuration);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function stake(uint256 amount) external nonReentrant notPaused updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        _totalSupply = _totalSupply.add(amount);
        _balances[msg.sender] = _balances[msg.sender].add(amount);
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        _totalSupply = _totalSupply.sub(amount);
        _balances[msg.sender] = _balances[msg.sender].sub(amount);
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewardsA[msg.sender];
        if (reward > 0) {
            rewardsA[msg.sender] = 0;
            rewardsTokenA.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, address(rewardsTokenA), reward);
        }
    }

    function exit() external {
        withdraw(_balances[msg.sender]);
        getReward();
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function notifyRewardAmount(uint256 rewardA) external onlyRewardsDistribution updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRateA = rewardA.div(rewardsDuration);
        } else {
            uint256 remaining = periodFinish.sub(block.timestamp);
            uint256 leftover = remaining.mul(rewardRateA);
            rewardRateA = rewardA.add(leftover).div(rewardsDuration);
        }

        // Ensure the provided reward amount is not more than the balance in the contract.
        // This keeps the reward rate in the right range, preventing overflows due to
        // very high values of rewardRate in the earned and rewardsPerToken functions;
        // Reward + leftover must be less than 2^256 / 10^18 to avoid overflow.
        uint balance = rewardsTokenA.balanceOf(address(this));
        require(rewardRateA <= balance.div(rewardsDuration), "Provided reward-A too high");

        lastUpdateTime = block.timestamp;
        console.log('periodFinish before update: %s ', periodFinish);
        periodFinish = block.timestamp.add(rewardsDuration);
        console.log('periodFinish after update: %s ', periodFinish);
        emit RewardAdded(rewardA);
    }

    // End rewards emission earlier
    function updatePeriodFinish(uint timestamp) external onlyOwner updateReward(address(0)) {
        periodFinish = timestamp;
    }

    // Added to support recovering LP Rewards from other systems such as BAL to be distributed to holders
    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        require(tokenAddress != address(stakingToken), "Cannot withdraw the staking token");
        IERC20(tokenAddress).safeTransfer(owner, tokenAmount);
        emit Recovered(tokenAddress, tokenAmount);
    }

    function setRewardsDuration(uint256 _rewardsDuration) external onlyOwner {
        require(
            block.timestamp > periodFinish,
            "Previous rewards period must be complete before changing the duration for the new period"
        );
        rewardsDuration = _rewardsDuration;
        emit RewardsDurationUpdated(rewardsDuration);
    }

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) {
        rewardPerTokenAStored = rewardPerTokenA();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewardsA[account] = earnedA(account);
            userRewardPerTokenAPaid[account] = rewardPerTokenAStored;
        }
        _;
    }

    /* ========== EVENTS ========== */

    event RewardAdded(uint256 rewardA);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, address rewardToken, uint256 reward);
    event RewardsDurationUpdated(uint256 newDuration);
    event Recovered(address token, uint256 amount);
}
