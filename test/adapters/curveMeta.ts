//@ts-nocheck
import { BigNumber, Signer } from "ethers"
import { MAX_UINT256, getUserTokenBalance } from "../amm/testUtils"
import { solidity } from "ethereum-waffle"
import { deployments } from "hardhat"

import { TestAdapterSwap } from "../build/typechain/TestAdapterSwap"
import { IERC20 } from "../../build/typechain/IERC20"
import { CurveMetaPoolAdapter } from "../../build/typechain/CurveMetaPoolAdapter"
import chai from "chai"
import { getBigNumber } from "../bridge/utilities"
import { setBalance } from "./utils/helpers"

import config from "../config.json"

chai.use(solidity)
const { expect } = chai

describe("Curve Meta Adapter", async () => {
  let signers: Array<Signer>

  let owner: Signer
  let ownerAddress: string
  let dude: Signer
  let dudeAddress: string

  let curveMetaPoolAdapter: CurveMetaPoolAdapter

  let testAdapterSwap: TestAdapterSwap

  // Test Values
  const TOKENS: IERC20[] = []
  // FRAX, DAI, USDC, USDT
  const TOKENS_DECIMALS = [18, 18, 6, 6]
  const STORAGE = [0, 2, 9, 2]

  const AMOUNTS = [8, 1001, 96420, 1337000]
  const AMOUNTS_BIG = [10200300, 100200300, 400500600]
  const CHECK_UNDERQUOTING = false

  async function testAdapter(
    adapter: Adapter,
    tokensFrom: Array<number>,
    tokensTo: Array<number>,
    times = 1,
    amounts = AMOUNTS,
    tokens = TOKENS,
    decimals = TOKENS_DECIMALS,
  ) {
    let swapsAmount = 0
    for (var k = 0; k < times; k++)
      for (let i of tokensFrom) {
        let tokenFrom = tokens[i]
        let decimalsFrom = decimals[i]
        for (let j of tokensTo) {
          if (i == j) {
            continue
          }
          let tokenTo = tokens[j]
          for (let amount of amounts) {
            swapsAmount++
            await testAdapterSwap.testSwap(
              adapter.address,
              getBigNumber(amount, decimalsFrom),
              tokenFrom.address,
              tokenTo.address,
              CHECK_UNDERQUOTING,
              swapsAmount,
            )
          }
        }
      }
  }

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      const { get } = deployments
      await deployments.fixture() // ensure you start from a fresh deployments

      TOKENS.length = 0
      signers = await ethers.getSigners()
      owner = signers[0]
      ownerAddress = await owner.getAddress()
      dude = signers[1]
      dudeAddress = await dude.getAddress()

      const testFactory = await ethers.getContractFactory("TestAdapterSwap")

      // we expect the quory to underQuote by 1 at maximum
      testAdapterSwap = (await testFactory.deploy(1)) as TestAdapterSwap

      let poolTokens = [
        config[1].assets.FRAX,
        config[1].assets.DAI,
        config[1].assets.USDC,
        config[1].assets.USDT,
      ]

      for (var i = 0; i < poolTokens.length; i++) {
        let token = (await ethers.getContractAt(
          "@synapseprotocol/sol-lib/contracts/solc8/erc20/IERC20.sol:IERC20",
          poolTokens[i],
        )) as IERC20
        TOKENS.push(token)

        let amount = getBigNumber(1e12, TOKENS_DECIMALS[i])
        await setBalance(ownerAddress, poolTokens[i], amount, STORAGE[i])
        expect(await getUserTokenBalance(ownerAddress, token)).to.eq(amount)
      }

      const curveAdapterFactory = await ethers.getContractFactory(
        "CurveMetaPoolAdapter",
      )

      curveMetaPoolAdapter = (await curveAdapterFactory.deploy(
        "CurveBaseAdapter",
        config[1].curve.frax,
        160000,
        config[1].curve.basepool,
      )) as CurveMetaPoolAdapter

      for (let token of TOKENS) {
        await token.approve(testAdapterSwap.address, MAX_UINT256)
      }
    },
  )

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_API,
            blockNumber: 14000000, // 2022-01-13
          },
        },
      ],
    })
  })

  beforeEach(async () => {
    await setupTest()
  })

  describe("Sanity checks", () => {
    it("Curve Adapter is properly set up", async () => {
      expect(await curveMetaPoolAdapter.pool()).to.eq(config[1].curve.frax)

      for (let i in TOKENS) {
        let token = TOKENS[i].address
        expect(await curveMetaPoolAdapter.isPoolToken(token))
        expect(await curveMetaPoolAdapter.tokenIndex(token)).to.eq(+i)
      }
    })

    it("Swap fails if transfer amount is too little", async () => {
      let amount = getBigNumber(10, TOKENS_DECIMALS[0])
      let depositAddress = await curveMetaPoolAdapter.depositAddress(
        TOKENS[0].address,
        TOKENS[1].address,
      )
      TOKENS[0].transfer(depositAddress, amount.sub(1))
      await expect(
        curveMetaPoolAdapter.swap(
          amount,
          TOKENS[0].address,
          TOKENS[1].address,
          ownerAddress,
        ),
      ).to.be.reverted
    })

    it("Only Owner can rescue overprovided swap tokens", async () => {
      let amount = getBigNumber(10, TOKENS_DECIMALS[0])
      let extra = getBigNumber(42, TOKENS_DECIMALS[0] - 1)
      let depositAddress = await curveMetaPoolAdapter.depositAddress(
        TOKENS[0].address,
        TOKENS[1].address,
      )
      TOKENS[0].transfer(depositAddress, amount.add(extra))
      await curveMetaPoolAdapter.swap(
        amount,
        TOKENS[0].address,
        TOKENS[1].address,
        ownerAddress,
      )

      await expect(
        curveMetaPoolAdapter
          .connect(dude)
          .recoverERC20(TOKENS[0].address, extra),
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(() =>
        curveMetaPoolAdapter.recoverERC20(TOKENS[0].address, extra),
      ).to.changeTokenBalance(TOKENS[0], owner, extra)
    })

    it("Anyone can take advantage of overprovided swap tokens", async () => {
      let amount = getBigNumber(10, TOKENS_DECIMALS[0])
      let extra = getBigNumber(42, TOKENS_DECIMALS[0] - 1)
      let depositAddress = await curveMetaPoolAdapter.depositAddress(
        TOKENS[0].address,
        TOKENS[1].address,
      )
      TOKENS[0].transfer(depositAddress, amount.add(extra))
      await curveMetaPoolAdapter.swap(
        amount,
        TOKENS[0].address,
        TOKENS[1].address,
        ownerAddress,
      )

      let swapQuote = await curveMetaPoolAdapter.query(
        extra,
        TOKENS[0].address,
        TOKENS[1].address,
      )

      // .add(1) to reflect underquoting by 1
      await expect(() =>
        curveMetaPoolAdapter
          .connect(dude)
          .swap(extra, TOKENS[0].address, TOKENS[1].address, dudeAddress),
      ).to.changeTokenBalance(TOKENS[1], dude, swapQuote.add(1))
    })

    it("Only Owner can rescue GAS from Adapter", async () => {
      let amount = 42690
      await expect(() =>
        owner.sendTransaction({
          to: curveMetaPoolAdapter.address,
          value: amount,
        }),
      ).to.changeEtherBalance(curveMetaPoolAdapter, amount)

      await expect(
        curveMetaPoolAdapter.connect(dude).recoverGAS(amount),
      ).to.be.revertedWith("Ownable: caller is not the owner")

      await expect(() =>
        curveMetaPoolAdapter.recoverGAS(amount),
      ).to.changeEtherBalances([curveMetaPoolAdapter, owner], [-amount, amount])
    })
  })

  describe("Adapter Swaps", () => {
    it("Swaps between tokens [144 small-medium swaps]", async () => {
      await testAdapter(curveMetaPoolAdapter, [0, 1, 2, 3], [0, 1, 2, 3], 3)
    })

    it("Swaps between tokens [144 big-ass swaps]", async () => {
      await testAdapter(
        curveMetaPoolAdapter,
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        4,
        AMOUNTS_BIG,
      )
    })
  })
})
