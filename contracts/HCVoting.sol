pragma solidity ^0.4.24;

import "./ProposalBase.sol";

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/common/IForwarder.sol";

import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@aragon/os/contracts/lib/math/SafeMath64.sol";

import "@aragon/apps-shared-minime/contracts/MiniMeToken.sol";


contract HCVoting is ProposalBase, IForwarder, AragonApp {
    using SafeMath for uint256;
    using SafeMath64 for uint64;

    /* ROLES */

    bytes32 public constant CREATE_PROPOSALS_ROLE = keccak256("CREATE_PROPOSALS_ROLE");

    /* ERRORS */

    string internal constant ERROR_BAD_REQUIRED_SUPPORT  = "HCVOTING_BAD_REQUIRED_SUPPORT";
    string internal constant ERROR_BAD_QUEUE_PERIOD      = "HCVOTING_BAD_QUEUE_PERIOD";
    string internal constant ERROR_PROPOSAL_IS_RESOLVED  = "HCVOTING_PROPOSAL_IS_RESOLVED";
    string internal constant ERROR_PROPOSAL_IS_CLOSED    = "HCVOTING_PROPOSAL_IS_CLOSED";
    string internal constant ERROR_ALREADY_VOTED         = "HCVOTING_ALREADY_VOTED";
    string internal constant ERROR_NO_VOTING_POWER       = "HCVOTING_NO_VOTING_POWER";
    string internal constant ERROR_NO_CONSENSUS          = "HCVOTING_NO_CONSENSUS";
    string internal constant ERROR_TOKEN_TRANSFER_FAILED = "HCVOTING_TOKEN_TRANSFER_FAILED";
    string internal constant ERROR_INSUFFICIENT_STAKE    = "HCVOTING_INSUFFICIENT_STAKE";
    string internal constant ERROR_CAN_NOT_FORWARD       = "HCVOTING_CAN_NOT_FORWARD";
    string internal constant ERROR_ALREADY_EXECUTED      = "HCVOTING_ALREADY_EXECUTED";

    /* CONSTANTS */

    // Used to avoid integer precision loss in divisions.
    uint256 internal constant MILLION = 1000000;

    /* DATA STRUCURES */

    enum ProposalState {
        Queued,
        Resolved,
        Closed
    }

    /* PROPERTIES */

    MiniMeToken public voteToken;
    MiniMeToken public stakeToken;

    uint256 public requiredSupport; // Expressed as parts per million, 51% = 510000
    uint64 public queuePeriod;

    /* EVENTS */

    event ProposalCreated(uint256 proposalId, address creator, string metadata);
    event VoteCasted(uint256 proposalId, address voter, bool supports);
    event ProposalUpstaked(uint256 indexed proposalId, address indexed staker, uint256 amount);
    event ProposalDownstaked(uint256 indexed proposalId, address indexed staker, uint256 amount);
    event UpstakeWithdrawn(uint256 indexed proposalId, address indexed staker, uint256 amount);
    event DownstakeWithdrawn(uint256 indexed proposalId, address indexed staker, uint256 amount);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalResolved(uint256 indexed proposalId);

    /* INIT */

    function initialize(
        MiniMeToken _voteToken,
        MiniMeToken _stakeToken,
        uint256 _requiredSupport,
        uint64 _queuePeriod
    )
        public onlyInit
    {
        initialized();

        require(_requiredSupport > 0, ERROR_BAD_REQUIRED_SUPPORT);
        require(_requiredSupport <= MILLION, ERROR_BAD_REQUIRED_SUPPORT);
        require(_queuePeriod > 0, ERROR_BAD_QUEUE_PERIOD);

        voteToken = _voteToken;
        stakeToken = _stakeToken;
        requiredSupport = _requiredSupport;
        queuePeriod = _queuePeriod;
    }

    /* PUBLIC */

    function propose(bytes _executionScript, string _metadata) public {
        uint64 creationBlock = getBlockNumber64() - 1;
        require(voteToken.totalSupplyAt(creationBlock) > 0, ERROR_NO_VOTING_POWER);

        uint256 proposalId = numProposals;
        numProposals++;

        Proposal storage proposal_ = proposals[proposalId];
        proposal_.creationBlock = creationBlock;
        proposal_.executionScript = _executionScript;

        uint64 currentDate = getTimestamp64();
        proposal_.creationDate = currentDate;
        proposal_.closeDate = currentDate.add(queuePeriod);

        emit ProposalCreated(proposalId, msg.sender, _metadata);
    }

    function vote(uint256 _proposalId, bool _supports) public {
        Proposal storage proposal_ = _getProposal(_proposalId);

        ProposalState state = getState(_proposalId);
        require(state != ProposalState.Resolved, ERROR_PROPOSAL_IS_RESOLVED);
        require(state != ProposalState.Closed, ERROR_PROPOSAL_IS_CLOSED);

        uint256 userVotingPower = voteToken.balanceOfAt(msg.sender, proposal_.creationBlock);
        require(userVotingPower > 0, ERROR_NO_VOTING_POWER);

        // Reject re-voting.
        require(getUserVote(_proposalId, msg.sender) == Vote.Absent, ERROR_ALREADY_VOTED);

        // Update user Vote and totalYeas/totalNays.
        if (_supports) {
            proposal_.totalYeas = proposal_.totalYeas.add(userVotingPower);
        } else {
            proposal_.totalNays = proposal_.totalNays.add(userVotingPower);
        }
        proposal_.votes[msg.sender] = _supports ? Vote.Yea : Vote.Nay;

        emit VoteCasted(_proposalId, msg.sender, _supports);
    }

    function stake(uint256 _proposalId, uint256 _amount, bool _upstake) public {
        Proposal storage proposal_ = _getProposal(_proposalId);

        ProposalState state = getState(_proposalId);
        require(state != ProposalState.Resolved, ERROR_PROPOSAL_IS_RESOLVED);
        require(state != ProposalState.Closed, ERROR_PROPOSAL_IS_CLOSED);

        if (_upstake) {
            proposal_.totalUpstake = proposal_.totalUpstake.add(_amount);
            proposal_.upstakes[msg.sender] = proposal_.upstakes[msg.sender].add(_amount);

            emit ProposalUpstaked(_proposalId, msg.sender, _amount);
        } else {
            proposal_.totalDownstake = proposal_.totalDownstake.add(_amount);
            proposal_.downstakes[msg.sender] = proposal_.downstakes[msg.sender].add(_amount);

            emit ProposalDownstaked(_proposalId, msg.sender, _amount);
        }

        require(
            stakeToken.transferFrom(msg.sender, address(this), _amount),
            ERROR_TOKEN_TRANSFER_FAILED
        );
    }

    function unstake(uint256 _proposalId, uint256 _amount, bool _upstake) public {
        Proposal storage proposal_ = _getProposal(_proposalId);

        ProposalState state = getState(_proposalId);
        require(state != ProposalState.Resolved, ERROR_PROPOSAL_IS_RESOLVED);

        if (_upstake) {
            require(getUserUpstake(_proposalId, msg.sender) >= _amount, ERROR_INSUFFICIENT_STAKE);

            proposal_.totalUpstake = proposal_.totalUpstake.sub(_amount);
            proposal_.upstakes[msg.sender] = proposal_.upstakes[msg.sender].sub(_amount);

            emit UpstakeWithdrawn(_proposalId, msg.sender, _amount);
        } else {
            require(getUserDownstake(_proposalId, msg.sender) >= _amount, ERROR_INSUFFICIENT_STAKE);

            proposal_.totalDownstake = proposal_.totalDownstake.sub(_amount);
            proposal_.downstakes[msg.sender] = proposal_.downstakes[msg.sender].sub(_amount);

            emit DownstakeWithdrawn(_proposalId, msg.sender, _amount);
        }

        require(
            stakeToken.transfer(msg.sender, _amount),
            ERROR_TOKEN_TRANSFER_FAILED
        );
    }

    function resolve(uint256 _proposalId) public {
        Proposal storage proposal_ = _getProposal(_proposalId);

        ProposalState state = getState(_proposalId);
        require(state != ProposalState.Resolved, ERROR_PROPOSAL_IS_RESOLVED);

        Vote support = getConsensus(_proposalId);
        require(support != Vote.Absent, ERROR_NO_CONSENSUS);

        proposal_.resolved = true;

        if (support == Vote.Yea) {
            _executeProposal(_proposalId, proposal_);
        }

        emit ProposalResolved(_proposalId);
    }

    /* CALCULATED PROPERTIES */

    function getState(uint256 _proposalId) public view returns (ProposalState) {
        Proposal storage proposal_ = _getProposal(_proposalId);

        if (proposal_.resolved) {
            return ProposalState.Resolved;
        }

        if (getTimestamp64() >= proposal_.closeDate) {
            return ProposalState.Closed;
        }

        return ProposalState.Queued;
    }

    function getConsensus(uint256 _proposalId) public view returns (Vote) {
        uint256 yeaPPM = getSupport(_proposalId, true);
        if (yeaPPM >= requiredSupport) {
            return Vote.Yea;
        }

        uint256 nayPPM = getSupport(_proposalId, false);
        if (nayPPM >= requiredSupport) {
            return Vote.Nay;
        }

        return Vote.Absent;
    }

    function getSupport(uint _proposalId, bool _supports) public view returns (uint256) {
        Proposal storage proposal_ = _getProposal(_proposalId);

        uint256 votingPower = voteToken.totalSupplyAt(proposal_.creationBlock);
        uint256 votes = _supports ? proposal_.totalYeas : proposal_.totalNays;

        return votes.mul(MILLION).div(votingPower);
    }

    /* FORWARDING */

    function isForwarder() external pure returns (bool) {
        return true;
    }

    function forward(bytes _evmScript) public {
        require(canForward(msg.sender, _evmScript), ERROR_CAN_NOT_FORWARD);
        propose(_evmScript, "");
    }

    function canForward(address _sender, bytes) public view returns (bool) {
        return canPerform(_sender, CREATE_PROPOSALS_ROLE, arr());
    }

    /* INTERNAL */

    function _executeProposal(uint256 _proposalId, Proposal storage proposal_) internal {
        require(!proposal_.executed, ERROR_ALREADY_EXECUTED);

        address[] memory blacklist = new address[](0);
        bytes memory input = new bytes(0);
        runScript(proposal_.executionScript, input, blacklist);

        proposal_.executed = true;

        emit ProposalExecuted(_proposalId);
    }
}
