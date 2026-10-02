import cds from '@sap/cds'

export default cds.server // re-export default bootstrap

cds.on('bootstrap', (app) => {
  app.use((req, _res, next) => {
    console.log(`[headers] ${req.method} ${req.path}`, JSON.stringify(req.headers, null, 2))
    next()
  })
})
