const { 
  defaultSetup,
  PRECISION_MULTIPLIER,
  CONFIDENCE_THRESHOLD_BASE,
  PENDED_BOOST_PERIOD_SECS,
  BOOST_PERIOD_SECS,
  QUIET_ENDING_PERIOD_SECS
} = require('./common.js');
const { EMPTY_SCRIPT } = require('@aragon/test-helpers/evmScript');
const { assertRevert } = require('@aragon/test-helpers/assertThrow');
const timeUtil = require('../scripts/timeUtil.js');

contract('HCVoting', accounts => {

  const [ 
    stakeHolder1, 
    stakeHolder2, 
    stakeHolder3, 
    stakeHolder4, 
    stakeHolder5, 
    voteHolder1,
    voteHolder2,
    voteHolder3,
    appManager
  ] = accounts;

  const HOLDER_1_STAKE_BALANCE = 100;
  const HOLDER_2_STAKE_BALANCE = 100;
  const HOLDER_3_STAKE_BALANCE = 200;
  const HOLDER_4_STAKE_BALANCE = 400;
  const HOLDER_5_STAKE_BALANCE = CONFIDENCE_THRESHOLD_BASE * HOLDER_1_STAKE_BALANCE;

  const HOLDER_1_VOTE_BALANCE = 100;
  const HOLDER_2_VOTE_BALANCE = 100;
  const HOLDER_3_VOTE_BALANCE = 200;

  const INIFINITE_ALLOWANCE = 100000000000000000;

  describe('When boosting proposals', () => {

    let timeElapsed = 0;

    beforeEach(async () => {
      await defaultSetup(this, appManager);

      await this.voteToken.generateTokens(voteHolder1, HOLDER_1_VOTE_BALANCE);
      await this.voteToken.generateTokens(voteHolder2, HOLDER_2_VOTE_BALANCE);
      await this.voteToken.generateTokens(voteHolder3, HOLDER_3_VOTE_BALANCE);

      await this.stakeToken.generateTokens(stakeHolder1, HOLDER_1_STAKE_BALANCE);
      await this.stakeToken.generateTokens(stakeHolder2, HOLDER_2_STAKE_BALANCE);
      await this.stakeToken.generateTokens(stakeHolder3, HOLDER_3_STAKE_BALANCE);
      await this.stakeToken.generateTokens(stakeHolder4, HOLDER_4_STAKE_BALANCE);
      await this.stakeToken.generateTokens(stakeHolder5, HOLDER_5_STAKE_BALANCE);

      await this.stakeToken.approve(this.app.address, INIFINITE_ALLOWANCE, { from: stakeHolder1 });
      await this.stakeToken.approve(this.app.address, INIFINITE_ALLOWANCE, { from: stakeHolder2 });
      await this.stakeToken.approve(this.app.address, INIFINITE_ALLOWANCE, { from: stakeHolder3 });
      await this.stakeToken.approve(this.app.address, INIFINITE_ALLOWANCE, { from: stakeHolder4 });
      await this.stakeToken.approve(this.app.address, INIFINITE_ALLOWANCE, { from: stakeHolder5 });

      await this.app.createProposal(EMPTY_SCRIPT, `Proposal message`);
      timeElapsed = 0;
    });
    
    it('A proposal\'s confidence factor should be available', async () => {
      await this.app.stake(0, 200, true, { from: stakeHolder4 });
      await this.app.stake(0, 100, false, { from: stakeHolder2 });
      expect((await this.app.getConfidence(0)).toString()).to.equal(`${2 * PRECISION_MULTIPLIER}`);
    });

    describe('When a proposal doesn\'t have enough confidence or is not pended', () => {
      
      it('An external account should not be able to boost it', async () => {
        await assertRevert(
          this.app.boostProposal(0, { from: stakeHolder1 }),
          `PROPOSAL_DOESNT_HAVE_ENOUGH_CONFIDENCE`
        );
      });
    });

    describe('When a proposal reaches enough confidence', () => {

      let pendedDateRecording;

      beforeEach(async () => {
        await this.app.stake(0, HOLDER_1_STAKE_BALANCE, false, { from: stakeHolder1 });
        await this.app.stake(0, HOLDER_5_STAKE_BALANCE, true, { from: stakeHolder5 });
        const [,,,lastPendedDate,] = await this.app.getProposalTimeInfo(0);
        pendedDateRecording = lastPendedDate.toNumber();
      });

      it('The confidence threshold should be reached', async () => {
        const threshold = CONFIDENCE_THRESHOLD_BASE * PRECISION_MULTIPLIER;
        expect((await this.app.getConfidence(0)).toString()).to.equal(`${threshold}`);
      });

      it('The proposal\'s state should change to Pended', async () => {
        const [,,state,] = await this.app.getProposalInfo(0);
        expect(state.toString()).to.equal(`2`); // ProposalState '2' = Pended
      });

      it('A decrease in confidence should set the proposal\'s state to Unpended', async () => {
        await this.app.stake(0, HOLDER_2_STAKE_BALANCE, false, { from: stakeHolder2 });
        const [,,state,] = await this.app.getProposalInfo(0);
        expect(state.toString()).to.equal(`1`); // ProposalState '1' = Unpended
      });

      describe('After 1/2 of pendedBoostPeriod elapses', () => {
        
        beforeEach(async () => {
          const timeToSkip = PENDED_BOOST_PERIOD_SECS / 2;
          await timeUtil.advanceTimeAndBlock(web3, timeToSkip);
          timeElapsed += timeToSkip;
        });

        it('The lastPendedDate should not have changed', async () => {
          const [,,,lastPendedDate,] = await this.app.getProposalTimeInfo(0);
          expect(lastPendedDate.toNumber()).to.be.equal(pendedDateRecording);
        });

        it('The lastPendedDate should not change after an increase in confidence', async () => {
          await this.app.stake(0, HOLDER_2_STAKE_BALANCE, true, { from: stakeHolder2 });
          const [,,,lastPendedDate,] = await this.app.getProposalTimeInfo(0);
          expect(lastPendedDate.toNumber()).to.be.equal(pendedDateRecording);
        });

        it('An external account should not be able to boost it', async () => {
          await assertRevert(
            this.app.boostProposal(0, { from: stakeHolder1 }),
            `PROPOSAL_HASNT_HAD_CONFIDENCE_ENOUGH_TIME`
          );
        });

        it('A decrease in confidence by an opposing stake should set the proposal\'s state to Unpended', async () => {
          await this.app.stake(0, HOLDER_2_STAKE_BALANCE, false, { from: stakeHolder2 });
          const [,,state,] = await this.app.getProposalInfo(0);
          expect(state.toString()).to.equal(`1`); // ProposalState '1' = Unpended
        });

        it('A decrease in confidence by a withdrawal of stake should set the proposal\'s state to Unpended', async () => {
          await this.app.unstake(0, HOLDER_5_STAKE_BALANCE, true, { from: stakeHolder5 });
          const [,,state,] = await this.app.getProposalInfo(0);
          expect(state.toString()).to.equal(`1`); // ProposalState '1' = Unpended
        });

        it('An increase in confidence should keep the proposal\'s state as Pended', async () => {
          await this.app.stake(0, HOLDER_2_STAKE_BALANCE, true, { from: stakeHolder2 });
          const [,,state,] = await this.app.getProposalInfo(0);
          expect(state.toString()).to.equal(`2`); // ProposalState '2' = Pended
        });

        describe('After pendedBoostPeriod (and a little more) elapses', async () => {

          beforeEach(async () => {
            const timeToSkip = 2 * 3600 + PENDED_BOOST_PERIOD_SECS / 2;
            await timeUtil.advanceTimeAndBlock(web3, timeToSkip);
            timeElapsed += timeToSkip;
          });

          it('An external caller should be able to boost the proposal, and receive a compensation for it', async () => {
            await this.app.boostProposal(0, { from: stakeHolder1 });
          });

          describe('When proposals are boosted', () => {

            let boostDateRecording;
            let boostProposalReceipt;

            beforeEach(async () => {

              await this.app.vote(0, true, { from: voteHolder1 });

              boostProposalReceipt = await this.app.boostProposal(0, { from: stakeHolder1 });
              boostDateRecording = new Date().getTime() / 1000;
            });
            
            it('The proposal\'s state should be changed to boosted', async () => {
              const [,,state,] = await this.app.getProposalInfo(0);
              expect(state.toString()).to.equal(`3`); // ProposalState '3' = Boosted
            });

            it('The proposals lifetime should be changed', async () => {
              const [,lifetime,,,] = await this.app.getProposalTimeInfo(0);
              expect(lifetime.toString()).to.equal(`${BOOST_PERIOD_SECS}`);
            });

            it('A ProposalStateChanged event should be triggered', async () => {
              const event = boostProposalReceipt.logs.filter(l => l.event === 'ProposalStateChanged')[0];
              expect(event).to.be.an('object');
              expect(event.args._proposalId.toString()).to.equal(`0`);
              expect(event.args._newState.toString()).to.equal(`3`); // ProposalState '3' = Boosted
            });

            it('Stakers should not be able to stake', async () => {
              await assertRevert(
                this.app.stake(0, HOLDER_2_STAKE_BALANCE, true, { from: stakeHolder2}),
                `PROPOSAL_IS_BOOSTED`
              );
            });

            it('Stakers should not be able to unstake', async () => {
              await assertRevert(
                this.app.unstake(0, HOLDER_5_STAKE_BALANCE, true, { from: stakeHolder5}),
                `PROPOSAL_IS_BOOSTED`
              );
            });

            it('An external caller shouldn\'t be able to boost a proposal once it has already been boosted', async () => {
              await assertRevert(
                this.app.boostProposal(0, { from: stakeHolder5}),
                `PROPOSAL_IS_BOOSTED`
              );
            });

            it('A decision flip before the quiet ending period should not extend it\'s lifetime', async () => {
              await this.app.vote(0, false, { from: voteHolder3 });
              const [,lifetime,,,] = await this.app.getProposalTimeInfo(0);
              expect(lifetime.toString()).to.equal(`${BOOST_PERIOD_SECS}`);
            });

            describe('In the quiet ending period of a proposal', () => {
              
              beforeEach(async () => {
                const timeToSkip = BOOST_PERIOD_SECS - timeElapsed - QUIET_ENDING_PERIOD_SECS / 2;
                await timeUtil.advanceTimeAndBlock(web3, timeToSkip);
                timeElapsed += timeToSkip;
              });

              describe('When there is a decision flip in the quiet ending period of a proposal', () => {

                let lastVoteReceipt;

                beforeEach(async () => {
                  lastVoteReceipt = await this.app.vote(0, false, { from: voteHolder3 });
                });

                it('A ProposalLifetimeExtended event should be triggered', async () => {
                  const event = lastVoteReceipt.logs.filter(l => l.event === 'ProposalLifetimeExtended')[0];
                  expect(event).to.be.an('object');
                  expect(event.args._proposalId.toString()).to.equal(`0`);
                  expect(event.args._newLifetime.toString()).to.equal(`${BOOST_PERIOD_SECS + QUIET_ENDING_PERIOD_SECS}`);
                });
                
                it('The proposal\'s lifetime should have changed', async () => {
                  const [,lifetime,,,] = await this.app.getProposalTimeInfo(0);
                  expect(lifetime.toString()).to.equal(`${BOOST_PERIOD_SECS + QUIET_ENDING_PERIOD_SECS}`);
                });
                
              });
            });
          });
        });
      });
    });
  });
});
