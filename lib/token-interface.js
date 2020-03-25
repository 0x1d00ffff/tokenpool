
var web3Utils = require('web3-utils')
var cluster = require('cluster')

const COLLECT_TOKEN_DATA_PERIOD = 30 * 1000

const ContractHelper = require('./util/contract-helper.js')

const poolConfig = require('../pool.config').config

var transactionCoordinator = require('./transaction-coordinator')

module.exports = {

  async init (redisInterface, mongoInterface, web3, accountConfig, pool_env) {
    this.redisInterface = redisInterface
    this.mongoInterface = mongoInterface
    this.web3 = web3
    this.pool_env = pool_env

    this.accountConfig = accountConfig

    this.tokenContract = ContractHelper.getTokenContract(this.web3, this.pool_env)

    if (cluster.isMaster) {
      this.redisInterface.dropList('recent_challenges')
      // load up the list with 5 blank entries ... saves having to always check the size
      // of the list later.
      this.redisInterface.pushToRedisList('recent_challenges', ['-', '-', '-', '-', '-'])
    }
  },

  async  update () {
    transactionCoordinator.init(this.web3, this.pool_env, this.redisInterface, this.mongoInterface)
    transactionCoordinator.update()

    var self = this
    await self.collectTokenParameters()

    setInterval(function () { self.collectTokenParameters() }, COLLECT_TOKEN_DATA_PERIOD)

    // do one right away
    setTimeout(function () { self.collectTokenParameters() }, 1000)

    setTimeout(function () { self.queueTokenTransfersForBalances() }, 0)
  },

  async getPoolChallengeNumber () {
    return await this.redisInterface.loadRedisData('challengeNumber')
  },

  async getPoolDifficultyTarget () {
    var targetString = await this.redisInterface.loadRedisData('miningTarget')
    return targetString
  },

  async getPoolDifficulty () {
    return await this.redisInterface.loadRedisData('miningDifficulty')
  },

  // uses infura

  async collectTokenParameters () {
    var miningDifficultyString = await this.tokenContract.methods.getMiningDifficulty().call()
    var miningDifficulty = parseInt(miningDifficultyString)

    var miningTargetString = await this.tokenContract.methods.getMiningTarget().call()
    var miningTarget = web3Utils.toBN(miningTargetString)

    var challengeNumber = await this.tokenContract.methods.getChallengeNumber().call()

    // console.log('Mining difficulty:', miningDifficulty);
    // console.log('Mining target:', miningTargetString);
    if (challengeNumber != this.challengeNumber) {
      // check if we've seen this challenge before
      var seenBefore = await this.redisInterface.isElementInRedisList('recent_challenges', challengeNumber)
      if (!seenBefore) {
        this.challengeNumber = challengeNumber
        console.log('collectTokenParameters: New challenge:', challengeNumber)
        this.redisInterface.pushToRedisList('recent_challenges', challengeNumber)
        this.redisInterface.popLastFromRedisList('recent_challenges')
        this.redisInterface.storeRedisData('challengeNumber', challengeNumber)
      } else {
        console.log('collectTokenParameters: Old challenge:', challengeNumber)
      }
    }

    this.miningDifficulty = miningDifficulty
    this.difficultyTarget = miningTarget

    this.redisInterface.storeRedisData('miningDifficulty', miningDifficulty)
    this.redisInterface.storeRedisData('miningTarget', miningTarget.toString())

    var web3 = this.web3
    var ethBlockNumber = await new Promise(function (fulfilled, error) {
      web3.eth.getBlockNumber(function (err, result) {
        if (err) { error(err); return }
        console.log('collectTokenParameters: eth block number ', result)
        fulfilled(result)
      })
    })

    this.redisInterface.storeRedisData('ethBlockNumber', ethBlockNumber)
  },

  async getEthBlockNumber () {
    var result = parseInt(await this.redisInterface.loadRedisData('ethBlockNumber'))
    if (isNaN(result) || result < 1) result = 0
    return result
  },

  // use address from ?
  async queueMiningSolution (solution_number, minerEthAddress, challenge_digest, challenge_number) {
    var currentTokenMiningReward = await this.requestCurrentTokenMiningReward()

    var txData = {
      minerEthAddress: minerEthAddress, // we use this differently in the pool!
      solution_number: solution_number,
      challenge_digest: challenge_digest,
      challenge_number: challenge_number,
      tokenReward: currentTokenMiningReward
    }

    await transactionCoordinator.addTransactionToQueue('solution', txData)
  },

  async getTokenBalanceOf (address) {
    var walletBalance = await this.tokenContract.methods.balanceOf(address).call()
    return walletBalance
  },

  async queueTokenTransfersForBalances () {
    // for each miner
    // if balance is higher than this
    // drain their balance and send that many tokens to them

    var self = this

    var minerList = await this.getMinerList()

    for (const i in minerList) // reward each miner
    {
      var minerAddress = minerList[i]

      var minerData = await this.getMinerData(minerAddress)

      if (typeof minerData.alltimeTokenBalance === 'undefined') minerData.alltimeTokenBalance = 0
      if (typeof minerData.tokensAwarded === 'undefined') minerData.tokensAwarded = 0

      var num_tokens_owed = 0
      if (minerData.alltimeTokenBalance > 0 && minerData.alltimeTokenBalance > minerData.tokensAwarded) {
        num_tokens_owed = Math.floor(minerData.alltimeTokenBalance - minerData.tokensAwarded)
      }

      if (typeof num_tokens_owed !== 'undefined' && num_tokens_owed > poolConfig.minBalanceForTransfer) {
        console.log('queueTokenTransfersForBalances: transfer tokens to   ', minerAddress)

        minerData.tokensAwarded += num_tokens_owed

        var blockNumber = await this.getEthBlockNumber()

        var balancePaymentData = {
          id: web3Utils.randomHex(32),
          minerAddress: minerAddress,
          previousTokenBalance: minerData.tokenBalance, // not used
          newTokenBalance: 0,
          amountToPay: num_tokens_owed,
          block: blockNumber
        }

        console.log('queueTokenTransfersForBalances: storing balance payment', ('balance_payments:' + minerAddress.toString().toLowerCase()), balancePaymentData)

        // this redis list is no longer used
        await this.redisInterface.pushToRedisList(('balance_payments:' + minerAddress.toString().toLowerCase()), JSON.stringify(balancePaymentData))

        // not used
        await this.redisInterface.storeRedisHashData('balance_payment', balancePaymentData.id, JSON.stringify(balancePaymentData))

        // store balance payment in mongo
        await this.mongoInterface.upsertOne('balance_payment', { id: balancePaymentData.id }, balancePaymentData) // should be handled by batching

        minerData.tokenBalance = 0

        // should store queued xfers in REDIS instead and monitor them for pending/success

        this.saveMinerDataToRedisMongo(minerAddress, minerData)
      }
    }

    setTimeout(function () { self.queueTokenTransfersForBalances() }, 20 * 1000)
  },

  async saveMinerDataToRedisMongo (minerEthAddress, minerData) {
    if (minerEthAddress == null) return
    minerEthAddress = minerEthAddress.toString().toLowerCase()
    await this.redisInterface.storeRedisHashData('miner_data_downcase', minerEthAddress, JSON.stringify(minerData))
    await this.mongoInterface.upsertOne('miner_data_downcase', { minerEthAddress: minerEthAddress }, minerData)
  },

  async getMinerData (minerEthAddress) {
    if (minerEthAddress == null) return
    minerEthAddress = minerEthAddress.toString().toLowerCase()
    var minerData = await this.mongoInterface.findOne('miner_data_downcase', { minerEthAddress: minerEthAddress })
    return minerData
  },

  // copied from peer
  async getMinerList () {
    var minerData = await this.redisInterface.getResultsOfKeyInRedis('miner_data_downcase')
    return minerData
  },

  getTransactionCoordinator () {
    return transactionCoordinator
  },

  getTokenContract () {
    return this.tokenContract
  },

  async requestCurrentTokenMiningReward () {
    var self = this
    var reward_amount = new Promise(function (fulfilled, error) {
      self.tokenContract.methods.getMiningReward().call(function (err, result) {
        if (err) { error(err); return }

        fulfilled(result)
      })
    })

    return reward_amount
  },

  getMintingAccount () {
    return this.accountConfig.minting
  },

  getPaymentAccount () {
    return this.accountConfig.payment
  }

}
