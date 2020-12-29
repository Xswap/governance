import chai, { expect } from 'chai'
import { Contract, BigNumber } from 'ethers'
import { solidity, MockProvider, createFixtureLoader, deployContract } from 'ethereum-waffle'

import XswapTreasuryVester from '../../build/XswapTreasuryVester.json'

import { governanceFixture } from '../fixtures'
import { mineBlock, expandTo18Decimals } from '../utils'

chai.use(solidity)

describe('scenario:XswapTreasuryVester', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet] = provider.getWallets()
  const loadFixture = createFixtureLoader([wallet], provider)

  let xswap: Contract
  let timelock: Contract
  beforeEach(async () => {
    const fixture = await loadFixture(governanceFixture)
    xswap = fixture.xswap
    timelock = fixture.timelock
  })

  let treasuryVester: Contract
  let vestingAmount: BigNumber
  let vestingBegin: number
  let vestingCliff: number
  let vestingEnd: number
  beforeEach('deploy treasury vesting contract', async () => {
    const { timestamp: now } = await provider.getBlock('latest')
    vestingAmount = expandTo18Decimals(100)
    vestingBegin = now + 60
    vestingCliff = vestingBegin + 60
    vestingEnd = vestingBegin + 60 * 60 * 24 * 365
    treasuryVester = await deployContract(wallet, XswapTreasuryVester, [
      xswap.address,
      timelock.address,
      vestingAmount,
      vestingBegin,
      vestingCliff,
      vestingEnd,
    ])

    // fund the treasury
    await xswap.transfer(treasuryVester.address, vestingAmount)
  })

  it('setRecipient:fail', async () => {
    await expect(treasuryVester.setRecipient(wallet.address)).to.be.revertedWith(
      'XswapTreasuryVester::setRecipient: unauthorized'
    )
  })

  it('claim:fail', async () => {
    await expect(treasuryVester.claim()).to.be.revertedWith('XswapTreasuryVester::claim: not time yet')
    await mineBlock(provider, vestingBegin + 1)
    await expect(treasuryVester.claim()).to.be.revertedWith('XswapTreasuryVester::claim: not time yet')
  })

  it('claim:~half', async () => {
    await mineBlock(provider, vestingBegin + Math.floor((vestingEnd - vestingBegin) / 2))
    await treasuryVester.claim()
    const balance = await xswap.balanceOf(timelock.address)
    expect(vestingAmount.div(2).sub(balance).abs().lte(vestingAmount.div(2).div(10000))).to.be.true
  })

  it('claim:all', async () => {
    await mineBlock(provider, vestingEnd)
    await treasuryVester.claim()
    const balance = await xswap.balanceOf(timelock.address)
    expect(balance).to.be.eq(vestingAmount)
  })
})
