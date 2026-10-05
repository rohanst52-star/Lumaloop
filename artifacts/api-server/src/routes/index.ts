import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketplaceRouter from "./marketplace";
import commerceRouter from "./commerce";
import storageRouter from "./storage";
import updatesRouter from "./updates";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(marketplaceRouter);
router.use(commerceRouter);
router.use(updatesRouter);

export default router;
