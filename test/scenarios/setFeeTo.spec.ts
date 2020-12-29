import chai, { expect } from 'chai'
import { Contract, constants } from 'ethers'
import { solidity, MockProvider, createFixtureLoader, deployContract } from 'ethereum-waffle'

import XswapV2Factory from '@xswap/v2-core/build/XswapV2Factory.json'
import XswapV2Pair from '@xswap/v2-core/build/XswapV2Pair.json'
import XswapFeeToSetter from '../../build/XswapFeeToSetter.json'
import XswapFeeTo from '../../build/XswapFeeTo.json'
import Xswap from '../../build/Xswap.json'

import { governanceFixture } from '../fixtures'
import { mineBlock, expandTo18Decimals } from '../utils'

chai.use(solidity)

describe('scenario:XswapFeeTo', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
      gasLimit: 9999999,
    },
  })
  const [wallet, other] = provider.getWallets()
  const loadFixture = createFixtureLoader([wallet], provider)

  beforeEach(async () => {
    await loadFixture(governanceFixture)
  })

  let factory: Contract
  beforeEach('deploy xswap v2', async () => {
    factory = await deployContract(wallet, XswapV2Factory, [wallet.address])
  })

  let xswapfeeToSetter: Contract
  let vestingEnd: number
  let xswapfeeTo: Contract
  beforeEach('deploy xswapfeeToSetter vesting contract', async () => {
    // deploy xswapfeeTo
    // constructor arg should be timelock, just mocking for testing purposes
    xswapfeeTo = await deployContract(wallet, XswapFeeTo, [wallet.address])

    const { timestamp: now } = await provider.getBlock('latest')
    vestingEnd = now + 60
    // 3rd constructor arg should be timelock, just mocking for testing purposes
    // 4th constructor arg should be xswapfeeTo, just mocking for testing purposes
    xswapfeeToSetter = await deployContract(wallet, XswapFeeToSetter, [
      factory.address,
      vestingEnd,
      wallet.address,
      xswapfeeTo.address,
    ])

    // set xswapfeeToSetter to be the vesting contract
    await factory.setFeeToSetter(feeToSetter.address)

    await mineBlock(provider, vestingEnd)
  })

  it('permissions', async () => {
    await expect(xswapfeeTo.connect(other).setOwner(other.address)).to.be.revertedWith('XswapFeeTo::setOwner: not allowed')

    await expect(xswapfeeTo.connect(other).setFeeRecipient(other.address)).to.be.revertedWith(
      'XswapFeeTo::setFeeRecipient: not allowed'
    )
  })

  describe('tokens', () => {
    const tokens: Contract[] = []
    beforeEach('make test tokens', async () => {
      const { timestamp: now } = await provider.getBlock('latest')
      const token0 = await deployContract(wallet, Xswap, [wallet.address, constants.AddressZero, now + 60 * 60])
      tokens.push(token0)
      const token1 = await deployContract(wallet, Xswap, [wallet.address, constants.AddressZero, now + 60 * 60])
      tokens.push(token1)
    })

    let pair: Contract
    beforeEach('create fee liquidity', async () => {
      // turn the fee on
      await xswapfeeToSetter.toggleFees(true)

      // create the pair
      await factory.createPair(tokens[0].address, tokens[1].address)
      const pairAddress = await factory.getPair(tokens[0].address, tokens[1].address)
      pair = new Contract(pairAddress, XswapV2Pair.abi).connect(wallet)

      // add liquidity
      await tokens[0].transfer(pair.address, expandTo18Decimals(1))
      await tokens[1].transfer(pair.address, expandTo18Decimals(1))
      await pair.mint(wallet.address)

      // swap
      await tokens[0].transfer(pair.address, expandTo18Decimals(1).div(10))
      const amounts =
        tokens[0].address.toLowerCase() < tokens[1].address.toLowerCase()
          ? [0, expandTo18Decimals(1).div(20)]
          : [expandTo18Decimals(1).div(20), 0]
      await pair.swap(...amounts, wallet.address, '0x', { gasLimit: 9999999 })

      // mint again to collect the rewards
      await tokens[0].transfer(pair.address, expandTo18Decimals(1))
      await tokens[1].transfer(pair.address, expandTo18Decimals(1))
      await pair.mint(wallet.address, { gasLimit: 9999999 })
    })

    it('updateTokenAllowState', async () => {
      await xswapfeeTo.updateTokenAllowState(tokens[0].address, true)
      let tokenAllowState = await XswapfeeTo.tokenAllowStates(tokens[0].address)
      expect(tokenAllowState[0]).to.be.true
      expect(tokenAllowState[1]).to.be.eq(1)

      await XswapfeeTo.updateTokenAllowState(tokens[0].address, false)
      tokenAllowState = await XswapfeeTo.tokenAllowStates(tokens[0].address)
      expect(tokenAllowState[0]).to.be.false
      expect(tokenAllowState[1]).to.be.eq(2)

      await XswapfeeTo.updateTokenAllowState(tokens[0].address, false)
      tokenAllowState = await XswapfeeTo.tokenAllowStates(tokens[0].address)
      expect(tokenAllowState[0]).to.be.false
      expect(tokenAllowState[1]).to.be.eq(2)

      await XswapfeeTo.updateTokenAllowState(tokens[0].address, true)
      tokenAllowState = await XswapfeeTo.tokenAllowStates(tokens[0].address)
      expect(tokenAllowState[0]).to.be.true
      expect(tokenAllowState[1]).to.be.eq(2)

      await XswapfeeTo.updateTokenAllowState(tokens[0].address, false)
      tokenAllowState = await XswapfeeTo.tokenAllowStates(tokens[0].address)
      expect(tokenAllowState[0]).to.be.false
      expect(tokenAllowState[1]).to.be.eq(3)
    })

    it('claim is a no-op if renounce has not been called', async () => {
      await XswapfeeTo.updateTokenAllowState(tokens[0].address, true)
      await XswapfeeTo.updateTokenAllowState(tokens[1].address, true)
      await XswapfeeTo.setFeeRecipient(other.address)

      const balanceBefore = await pair.balanceOf(other.address)
      expect(balanceBefore).to.be.eq(0)
      await XswapfeeTo.claim(pair.address)
      const balanceAfter = await pair.balanceOf(other.address)
      expect(balanceAfter).to.be.eq(0)
    })

    it('renounce works', async () => {
      await XswapfeeTo.updateTokenAllowState(tokens[0].address, true)
      await XswapfeeTo.updateTokenAllowState(tokens[1].address, true)
      await XswapfeeTo.setFeeRecipient(other.address)

      const totalSupplyBefore = await pair.totalSupply()
      await XswapfeeTo.renounce(pair.address, { gasLimit: 9999999 })
      const totalSupplyAfter = await pair.totalSupply()
      expect(totalSupplyAfter.lt(totalSupplyBefore)).to.be.true
    })

    it('claim works', async () => {
      await XswapfeeTo.updateTokenAllowState(tokens[0].address, true)
      await XswapfeeTo.updateTokenAllowState(tokens[1].address, true)
      await XswapfeeTo.setFeeRecipient(other.address)

      await XswapfeeTo.renounce(pair.address, { gasLimit: 9999999 })

      // swap
      await tokens[0].transfer(pair.address, expandTo18Decimals(1).div(10))
      const amounts =
        tokens[0].address.toLowerCase() < tokens[1].address.toLowerCase()
          ? [0, expandTo18Decimals(1).div(1000)]
          : [expandTo18Decimals(1).div(1000), 0]
      await pair.swap(...amounts, wallet.address, '0x', { gasLimit: 9999999 })

      // mint again to collect the rewards
      await tokens[0].transfer(pair.address, expandTo18Decimals(1))
      await tokens[1].transfer(pair.address, expandTo18Decimals(1))
      await pair.mint(wallet.address, { gasLimit: 9999999 })

      const balanceBefore = await pair.balanceOf(other.address)
      await XswapfeeTo.claim(pair.address, { gasLimit: 9999999 })
      const balanceAfter = await pair.balanceOf(other.address)
      expect(balanceAfter.gt(balanceBefore)).to.be.true
    })
  })
})