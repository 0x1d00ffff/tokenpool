/*

Turns queued ethereum transaction into actual ones :)

Waits for pending TX to be mined before sending another !

Solutions are highest priority

*/

const TransactionHelper = require('./util/transaction-helper')
const poolConfig = require('../pool.config').config

var web3utils = require('web3-utils')

module.exports = {

  async init (web3, pool_env, redisInterface, mongoInterface) {
    this.web3 = web3
    this.redisInterface = redisInterface
    this.mongoInterface = mongoInterface

    this.pool_env = pool_env

    TransactionHelper.init(web3, pool_env, redisInterface, mongoInterface)
  },

  async update () {
    var self = this

    setTimeout(function () { self.broadcastQueuedMintTransactions() }, 0)

    setTimeout(function () { self.updateBroadcastedTransactionStatus() }, 0)

    /* force check of pending batch payments before starting batch tasks */
    try {
      await TransactionHelper.checkBatchPaymentsStatus()
    } catch (err) {}

    setTimeout(function () { self.periodicBroadcastPaymentBatches() }, 0)

    /* start batching available payments 60 seconds after the pool has started */
    setTimeout(function () { self.periodicBatchMinedPayments() }, 60 * 1000)

    /* this call is delayed because we call checkBatchPaymentsStatus manually above  */
    setTimeout(function () { self.periodicCheckBatchPaymentsStatus() }, 30 * 1000)
  },

  /*
  KEY
  queued - transaction not broadcasted yet
  pending - transaction broadcasted but not mined
  mined - transaction mined !
  successful - transaction mined and not reverted

  */
  async getEthBlockNumber () {
    var result = parseInt(await this.redisInterface.loadRedisData('ethBlockNumber'))

    if (isNaN(result) || result < 1) result = 0

    return result
  },

  /* periodically broadcast the oldest unconfirmed payment batch */
  async periodicBroadcastPaymentBatches () {
    var self = this
    try {
      await TransactionHelper.broadcastPaymentBatches()
    } catch (e) {
      console.log('periodicBroadcastPaymentBatches: broadcastPaymentBatches error', e)
    }
    // TODO: change to 10m or faster after confirming it replaces existing broadcasted transactions
    setTimeout(function () { self.periodicBroadcastPaymentBatches() }, 5 * 60 * 1000) // 4 minutes
  },

  /* periodically create a batch payment which combines available balance payments */
  async periodicBatchMinedPayments () {
    var self = this
    try {
      await this.batchMinedPayments()
    } catch (e) {
      console.log('periodicBatchMinedPayments: batchMinedPayments error', e)
    }
    // TODO: change to 60m or slower so we batch more payments together
    setTimeout(function () { self.periodicBatchMinedPayments() }, 10 * 60 * 1000) // 10 minutes
  },

  /* periodically check all batch payments for completion */
  async periodicCheckBatchPaymentsStatus () {
    var self = this
    try {
      await TransactionHelper.checkBatchPaymentsStatus()
    } catch (e) {
      console.log('periodicCheckBatchPaymentsStatus: checkBatchPaymentsStatus error', e)
    }
    setTimeout(function () { self.periodicCheckBatchPaymentsStatus() }, 30 * 1000) // 30 seconds
  },

  /*
    Create a new batch payment using all unassigned balance payments (max of 25) and
    add to the database.

    This task should run at least fast enough to empty out all unassigned balance
    payments over time. See first TODO.
    It should also run _slow_ enough that multiple balance payments are available
    to be combined into this new batch.

    TODO: This function should be modified to make multiple batches if necessary to
          consume all unassigned balance payments. Then this task can run much less
          often, perhaps once every 24 hours.
    TODO: If there are multiple balance payments to the same miner, this would be a
          good location to consolidate them into a single larger payment.
  */
  async batchMinedPayments () {
    var self = this

    var unbatched_pmnts = await self.mongoInterface.findAll('balance_payment', { batchId: null })

    console.log('batchMinedPayments: check unbatched mined payments:', unbatched_pmnts.length, 'found')

    var batchedPayments = 0

    const MIN_PAYMENTS_IN_BATCH = Math.min(1, poolConfig.minPaymentsInBatch) // 5

    if (unbatched_pmnts.length >= MIN_PAYMENTS_IN_BATCH) {
      var batchData = {
        id: web3utils.randomHex(32),
        confirmed: false
      }

      await self.mongoInterface.upsertOne('payment_batch', { id: batchData.id }, batchData)

      var paymentsToBatch = unbatched_pmnts.slice(0, 25) // max to batch is 25

      // add these payments to the new batch by setting their foreign key
      for (var element of paymentsToBatch) {
        element.batchId = batchData.id

        await self.mongoInterface.upsertOne('balance_payment', { id: element.id }, element)

        batchedPayments++
      }
      console.log(`batchMinedPayments: new batch ${batchData.id} with ${paymentsToBatch.length} payments`)
    }

    return { success: true, batchedPayments: batchedPayments }
  },

  // wait 5000 blocks in between batch broadcasts

  // types can be one of: ['solution']
  async addTransactionToQueue (txType, txData) {
    // add to redis

    var receiptData = {
      queued: true,
      pending: false,
      mined: false,
      success: false
    }
    var blockNum = await this.getEthBlockNumber()

    var packetData = {
      block: blockNum,
      txType: txType,
      txData: txData,
      receiptData: receiptData
    }

    console.log(`addTransactionToQueue: block:${blockNum} type:${txType} receipt:${receiptData}`)

    // packt data is undefined !!
    if (packetData.txType == 'solution') {
      await this.redisInterface.pushToRedisList('queued_mint_transactions', JSON.stringify(packetData))
    }
  },

  async markTransactionAsLost (tx_hash, packetData) {
    console.log('markTransactionAsLost: mark transaction as lost !!!! ')

    await this.redisInterface.pushToRedisList('lost_transactions_list', JSON.stringify(packetData))

    var packetDataJSON = await this.redisInterface.findHashInRedis('active_transactions', tx_hash)
    packetData = JSON.parse(packetDataJSON)

    packetData.receiptData = { // lost
      queued: false,
      pending: false,
      mined: false,
      success: false,
      lost: true
    }

    // resave
    await this.storeEthereumTransaction(tx_hash, packetData)
  },

  // broadcasted to the network
  async storeEthereumTransaction (tx_hash, packetData) {
    console.log('storeEthereumTransaction: storing data about eth tx ', tx_hash, packetData)

    await this.redisInterface.storeRedisHashData('active_transactions', tx_hash, JSON.stringify(packetData))

    var listPacketData = packetData
    listPacketData.txHash = tx_hash

    await this.redisInterface.pushToRedisList('active_transactions_list', JSON.stringify(listPacketData))

    return true
  },

  async getPacketReceiptDataFromWeb3Receipt (liveTransactionReceipt) {
    var mined = (liveTransactionReceipt != null)
    var success = false

    if (mined) {
      success = ((liveTransactionReceipt.status == true) ||
                                       (web3utils.hexToNumber(liveTransactionReceipt.status) == 1))
    }

    var receiptData = {
      queued: false,
      pending: !mined,
      mined: mined,
      success: success
    }

    return receiptData
  },

  async broadcastQueuedMintTransactions () {
    var self = this
    var transactionStats = await this.getTransactionStatistics() // .queuedCount .pendingCount  .minedCount

    var hasPendingTransaction = true

    var nextQueuedTransactionDataJSON = await this.redisInterface.peekFirstFromRedisList('queued_mint_transactions')
    var nextQueuedTransactionData = JSON.parse(nextQueuedTransactionDataJSON)

    if (nextQueuedTransactionData != null && nextQueuedTransactionData.txType == 'solution') {
      hasPendingTransaction = (transactionStats.pendingMintsCount > 0)
    }

    var hasQueuedTransaction = (transactionStats.queuedCount > 0)

    if (hasQueuedTransaction && !hasPendingTransaction) {
      try {
        nextQueuedTransactionData = await this.redisInterface.popFromRedisList('queued_mint_transactions')
        var nextQueuedTransaction = JSON.parse(nextQueuedTransactionData)
        console.log(`broadcastQueuedMintTransactions: block:${nextQueuedTransaction.blockNum} type:${nextQueuedTransaction.txType} receipt:${nextQueuedTransaction.receiptData}`)

        var successful_broadcast = await this.broadcastTransaction(nextQueuedTransaction)
        if (!successful_broadcast) {
          console.error('broadcastQueuedMintTransactions: unsuccessful broadcast! ')

          // this is putting in a bad entry !! like 'true '
          //   await this.redisInterface.pushToRedisList('queued_transactions',nextQueuedTransactionData)
        }
      } catch (e) {
        console.log('broadcastQueuedMintTransactions: caught error', e)
      }
    }
    setTimeout(function () { self.broadcastQueuedMintTransactions() }, 5 * 1000)
  },

  async broadcastTransaction (transactionPacketData) {
    var txData = transactionPacketData.txData
    var txType = transactionPacketData.txType
    var tx_hash = null
    console.log(`broadcastTransaction: ---- broadcast transaction ---- (${txType})`)

    if (txType == 'solution') {
      var currentChallengeNumber = await TransactionHelper.requestCurrentChallengeNumber()
      if (txData == null || currentChallengeNumber != txData.challenge_number) {
        console.log('broadcastTransaction: stale challenge number!  Not submitting solution to contract ')
        return false
      }
      tx_hash = await TransactionHelper.submitMiningSolutionTwo(txData.minerEthAddress, txData.solution_number, txData.challenge_digest, txData.challenge_number)
    } else {
      console.error(`broadcastTransaction: invalid tx type! (${txType}) ${txData}`)
      return false
    }

    if (tx_hash == null) {
      console.error('broadcastTransaction: Tx not broadcast successfully', txType, txData)
      return false
    } else {
      console.log(`broadcastTransaction: broadcasted ${txType}; txhash:${tx_hash}`)
      if (txType == 'solution') {
        await this.storeNewSubmittedSolutionTransactionHash(tx_hash, txData.tokenReward, txData.minerEthAddress, txData.challenge_number)
      }
      transactionPacketData.receiptData = {
        queued: false,
        pending: true,
        mined: false,
        success: false
      }
      // resave
      await this.storeEthereumTransaction(tx_hash, transactionPacketData)
      return true
    }
  },

  async updateBroadcastedTransactionStatus () {
    var self = this

    try {
      var ethereumTransactionHashes = await this.redisInterface.getResultsOfKeyInRedis('active_transactions')

      for (const i in ethereumTransactionHashes) {
        var txHash = ethereumTransactionHashes[i]
        var packetDataJSON = await this.redisInterface.findHashInRedis('active_transactions', txHash)
        var packetData = JSON.parse(packetDataJSON)

        if (packetData.receiptData.mined == false && packetData.receiptData.lost != true) {
          console.log('updateBroadcastedTransactionStatus: active packet: ', packetData)

          var receipt = await this.requestTransactionReceipt(txHash)

          console.log('updateBroadcastedTransactionStatus: receipt: ', receipt)

          if (receipt != null) {
            console.log('updateBroadcastedTransactionStatus: got receipt storing packet ')
            packetData.receiptData = await this.getPacketReceiptDataFromWeb3Receipt(receipt)

            await this.storeEthereumTransaction(txHash, packetData)
          } else {
            console.log('updateBroadcastedTransactionStatus: block of pending tx : ', packetData.block)

            var current_block = await this.getEthBlockNumber()
            var pending_block = packetData.block

            var LOST_TX_BLOCK_COUNT = 50

            console.log('updateBroadcastedTransactionStatus:', current_block, pending_block)
            // rebroadcast
            if ((current_block - pending_block > LOST_TX_BLOCK_COUNT && pending_block > 0) ||
                  (current_block - pending_block < -10000)) // something is messed up
            {
              console.log('updateBroadcastedTransactionStatus: lost !! ', packetData)

              await this.markTransactionAsLost(txHash, packetData)
            }
          }
        }
      }
    } catch (e) {
      console.log('updateBroadcastedTransactionStatus: caught error', e)
    }

    setTimeout(function () { self.updateBroadcastedTransactionStatus() }, 2000)
  },

  async getTransactionStatistics () {
    var pendingCount = 0
    var queuedCount = 0
    var minedCount = 0
    var successCount = 0

    var queuedMintsCount = 0

    var pendingMintsCount = 0
    var pendingPaymentsCount = 0

    var queuedMintsTransactions = await this.redisInterface.getElementsOfListInRedis('queued_mint_transactions')

    var ethereumTransactionHashes = await this.redisInterface.getResultsOfKeyInRedis('active_transactions')

    var ethereumTransactions = []

    for (const i in ethereumTransactionHashes) {
      var hash = ethereumTransactionHashes[i]
      //  console.log( 'hash',hash)
      ethereumTransactions.push(await this.redisInterface.findHashInRedis('active_transactions', hash))
    }

    var transactionPacketsData = []

    queuedMintsTransactions.map(item => transactionPacketsData.push(JSON.parse(item)))
    // queuedPaymentsTransactions.map(item => transactionPacketsData.push(JSON.parse(item)))
    ethereumTransactions.map(item => transactionPacketsData.push(JSON.parse(item)))

    //        console.log('transactionPacketsData',transactionPacketsData)

    transactionPacketsData.map(function (item) {
      //  console.log('item',item)

      var receiptData = item.receiptData

      if (receiptData.pending) {
        pendingCount++

        if (item.txType == 'transfer') {
          pendingPaymentsCount++
        }
        if (item.txType == 'solution') {
          pendingMintsCount++
        }
      }

      if (receiptData.queued) {
        queuedCount++

        if (item.txType == 'solution') {
          queuedMintsCount++
        }
      }

      if (receiptData.mined)minedCount++
      if (receiptData.success)successCount++
    })

    await this.redisInterface.storeRedisData('queuedTxCount', queuedCount)
    await this.redisInterface.storeRedisData('pendingTxCount', pendingCount)
    await this.redisInterface.storeRedisData('minedTxCount', minedCount)
    await this.redisInterface.storeRedisData('successTxCount', successCount)

    await this.redisInterface.storeRedisData('queuedMintsCount', queuedMintsCount)
    await this.redisInterface.storeRedisData('queuedPaymentsCount', 0)
    await this.redisInterface.storeRedisData('pendingMintsCount', pendingMintsCount)
    await this.redisInterface.storeRedisData('pendingPaymentsCount', pendingPaymentsCount)

    var stats = {
      queuedCount: queuedCount,
      pendingCount: pendingCount,
      minedCount: minedCount,
      successCount: successCount,
      pendingMintsCount: pendingMintsCount,
      pendingPaymentsCount: pendingPaymentsCount
    }

    return stats
  },

  async requestTransactionData (tx_hash) {
    try {
      var data = await this.web3.eth.getTransaction(tx_hash)
    } catch (err) {
      console.error('requestTransactionData: could not find tx ', tx_hash)
      return null
    }

    return data
  },

  async requestTransactionReceipt (tx_hash) {
    try {
      var receipt = await this.web3.eth.getTransactionReceipt(tx_hash)
    } catch (err) {
      console.error('requestTransactionReceipt: could not find receipt ', tx_hash)
      return null
    }
    return receipt
  },

  // required for balance payouts
  async storeNewSubmittedSolutionTransactionHash (tx_hash, tokensAwarded, minerEthAddress, challengeNumber) {
    var blockNum = await this.getEthBlockNumber()

    var txData = {
      block: blockNum,
      tx_hash: tx_hash,
      minerEthAddress: minerEthAddress,
      challengeNumber: challengeNumber,
      mined: false, // completed being mined ?
      succeeded: false,
      token_quantity_rewarded: tokensAwarded,
      rewarded: false // did we win the reward of 50 tokens ?
    }

    console.log('storeNewSubmittedSolutionTransactionHash: Storing submitted solution data ', txData)
    this.redisInterface.storeRedisHashData('unconfirmed_submitted_solution_tx', tx_hash, JSON.stringify(txData))
  },

  async getBalanceTransferConfirmed (paymentId) {
    // check balance payment

    var balanceTransferJSON = await this.redisInterface.findHashInRedis('balance_transfer', paymentId)
    var balanceTransfer = JSON.parse(balanceTransferJSON)

    if (balanceTransferJSON == null || balanceTransfer.txHash == null) {
      return false
    } else {
      // dont need to check receipt because we wait many blocks between broadcasts - enough time for the monitor to populate this data correctly
      return balanceTransfer.confirmed
    }
  }

}
