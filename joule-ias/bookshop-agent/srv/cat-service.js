import cds from '@sap/cds'

export default class CatalogService extends cds.ApplicationService {
  async init() {
    this.on('submitOrder', async (req) => {
      const { bookId } = req.data
      return `Order submitted for book #${bookId} and user ${req.user?.id}`
    })

    this.on('getProfileInfo', async (req) => {
      return JSON.stringify({ email: req.user?.id ?? 'anonymous', orders: 2 })
    })

    return super.init()
  }
}
