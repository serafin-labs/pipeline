import * as _ from "lodash"
import * as util from "util"
import { SchemaBuilder } from "@serafin/schema-builder"
import { notImplementedError, error } from "./error"
import { IdentityInterface } from "./IdentityInterface"
import { SchemaBuildersInterface, schemaBuildersInterfaceKeys } from "./SchemaBuildersInterface"
import { Pipe, PipeActionsInterface } from "./PipeInterface"
import { Relation } from "./Relation"
import { ResultsInterface } from "./ResultsInterface"
import {
    PipelineCreateFunction,
    PipelineDeleteFunction,
    PipelineInterface,
    PipelineMethods,
    PipelinePatchFunction,
    PipelineReadFunction,
    ReadOnlyPipelineInterface,
    pipelineMethods,
} from "./PipelineInterface"
import { RelationType } from "./RelationType"

export interface PipelineAbstractOptions {
    validationEnabled?: boolean
    name?: string
}
export const defaultPipelineAbstractOptions: PipelineAbstractOptions = { validationEnabled: true }

export abstract class PipelineAbstract<
    M extends IdentityInterface = IdentityInterface,
    CV = any,
    CO = any,
    RQ = any,
    PQ = any,
    PV = any,
    DQ = any,
    CM = any,
    RM = any,
    PM = any,
    DM = any,
    CTX = any,
    R extends Record<string, Relation<IdentityInterface, string, IdentityInterface, any, any, RelationType>> = {},
> implements PipelineInterface<M, CV, CO, RQ, PQ, PV, DQ, CM, RM, PM, DM, CTX>
{
    public relations: R = {} as R

    private pipes: PipeActionsInterface[] = []

    private options: PipelineAbstractOptions

    constructor(public schemaBuilders: SchemaBuildersInterface<M, CV, CO, RQ, PQ, PV, DQ, CM, RM, PM, DM, CTX>, options?: PipelineAbstractOptions) {
        this.options = { ...defaultPipelineAbstractOptions, ...options }
    }

    public get modelSchemaBuilder() {
        return this.schemaBuilders.model as SchemaBuilder<M>
    }

    public pipe<
        M2 extends IdentityInterface = M,
        CV2 = CV,
        CO2 = CO,
        RQ2 = RQ,
        PQ2 = PQ,
        PV2 = PV,
        DQ2 = DQ,
        CM2 = CM,
        RM2 = RM,
        PM2 = PM,
        DM2 = DM,
        CTX2 = CTX,
    >(pipe: Pipe<M, CV, CO, RQ, PQ, PV, DQ, CM, RM, PM, DM, CTX, M2, CV2, CO2, RQ2, PQ2, PV2, DQ2, CM2, RM2, PM2, DM2, CTX2>) {
        // run the pipe
        const result =
            typeof pipe === "function"
                ? pipe({
                      ...this.schemaBuilders,
                  })
                : pipe.transform({
                      ...this.schemaBuilders,
                  })
        // combine schema modifications with the current schemas
        const newPipeline = this.clone() as any as PipelineAbstract<M2, CV2, CO2, RQ2, PQ2, PV2, DQ2, CM2, RM2, PM2, DM2, CTX2, R>
        const modifiedSchemas = _.pick(result, schemaBuildersInterfaceKeys)
        if (Object.keys(modifiedSchemas).length > 0) {
            newPipeline.schemaBuilders = {
                ...this.schemaBuilders,
                ...modifiedSchemas,
            } as any
        }
        // add pipe methods modifications to the pipeline if it implements at least one of the CRUD methods
        const modifiedMethods = _.pickBy(result, (v, k) => !!v && pipelineMethods.includes(k as any))
        if (Object.keys(modifiedMethods).length > 0) {
            newPipeline.pipes = [
                _.mapValues(
                    modifiedMethods,
                    (value: any, key) =>
                        (...props: any[]) =>
                            value(...props, this), // the current pipeline is provided as the last argument
                ),
                ...this.pipes,
            ]
        }

        return newPipeline
    }

    /**
     * Build a recursive function that will call all the pipes for a CRUD method
     */
    private pipeChain(method: PipelineMethods) {
        const callChain = async (i: number, ...args: any[]) => {
            while (i < this.pipes.length && !this.pipes[i][method]) {
                ++i
            }
            if (i >= this.pipes.length) {
                return (this[`_${method}`] as (...args: any[]) => any)(...args)
            } else {
                return (this.pipes[i++] as any)[method]((...args: any[]) => callChain(i, ...args), ...args)
            }
        }
        return async (...args: any[]) => callChain(0, ...args)
    }

    /**
     * Add a many relation to the pipeline.
     * A query parameter is added to the all actions to conditionally fetch the related entities.
     */
    public addRelationWithMany<NameKey extends string, RelationModel extends IdentityInterface, ReadQuery, ReadMeta>(
        name: NameKey,
        pipeline: ReadOnlyPipelineInterface<RelationModel, ReadQuery, ReadMeta>,
        query: Partial<ReadQuery>,
    ) {
        const relationSchema = SchemaBuilder.arraySchema(pipeline.schemaBuilders.model)
        const relationOption = `with${_.upperFirst(name)}` as `with${Capitalize<NameKey>}`
        const relationOptionSchema = SchemaBuilder.booleanSchema({ description: `If set to 'true', the result will include the property '${name}'` })
        const relation: Relation<M, NameKey, RelationModel, ReadQuery, ReadMeta, RelationType.many> = new Relation(
            this,
            name,
            pipeline,
            query,
            RelationType.many,
        )
        const newPipeline = (
            this as any as PipelineAbstract<
                M,
                CV,
                CO,
                RQ,
                PQ,
                PV,
                DQ,
                CM,
                RM,
                PM,
                DM,
                CTX,
                R & { [key in NameKey]: Relation<M, NameKey, RelationModel, ReadQuery, ReadMeta, RelationType.many> }
            >
        ).pipe((p) => {
            const model = p.model.addProperty(name, relationSchema, false)
            const readQuery = p.readQuery.addProperty(relationOption, relationOptionSchema, false)
            const createOptions = p.createOptions.addProperty(relationOption, relationOptionSchema, false)
            const patchQuery = p.patchQuery.addProperty(relationOption, relationOptionSchema, false)
            const deleteQuery = p.deleteQuery.addProperty(relationOption, relationOptionSchema, false)
            return {
                model,
                readQuery,
                createOptions,
                patchQuery,
                deleteQuery,
                create: async (next, resources, options, context) => {
                    const result = await next(resources, options, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
                read: async (next, query: typeof readQuery.T, context) => {
                    const result = await next(query, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
                patch: async (next, query, values, context) => {
                    const result = await next(query, values, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
                delete: async (next, query, context) => {
                    const result = await next(query, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
            }
        })
        newPipeline.relations[name] = relation as any
        return newPipeline
    }

    /**
     * Add a one relation to the pipeline.
     * A query parameter is added to the all actions to conditionally fetch the related entity.
     */
    public addRelationWithOne<NameKey extends string, RelationModel extends IdentityInterface, ReadQuery, ReadMeta>(
        name: NameKey,
        pipeline: ReadOnlyPipelineInterface<RelationModel, ReadQuery, ReadMeta>,
        query: Partial<ReadQuery>,
    ) {
        const relationSchema = pipeline.schemaBuilders.model
        const relationOption = `with${_.upperFirst(name)}` as `with${Capitalize<NameKey>}`
        const relationOptionSchema = SchemaBuilder.booleanSchema({ description: `If set to 'true', the result will include the property '${name}'` })
        const relation: Relation<M, NameKey, RelationModel, ReadQuery, ReadMeta, RelationType.one> = new Relation(this, name, pipeline, query, RelationType.one)
        const newPipeline = (
            this as any as PipelineAbstract<
                M,
                CV,
                CO,
                RQ,
                PQ,
                PV,
                DQ,
                CM,
                RM,
                PM,
                DM,
                CTX,
                R & { [key in NameKey]: Relation<M, NameKey, RelationModel, ReadQuery, ReadMeta, RelationType.one> }
            >
        ).pipe((p) => {
            const model = p.model.addProperty(name, relationSchema, false)
            const readQuery = p.readQuery.addProperty(relationOption, relationOptionSchema, false)
            const createOptions = p.createOptions.addProperty(relationOption, relationOptionSchema, false)
            const patchQuery = p.patchQuery.addProperty(relationOption, relationOptionSchema, false)
            const deleteQuery = p.deleteQuery.addProperty(relationOption, relationOptionSchema, false)
            return {
                model,
                readQuery,
                createOptions,
                patchQuery,
                deleteQuery,
                create: async (next, resources, options, context) => {
                    const result = await next(resources, options, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
                read: async (next, query: typeof readQuery.T, context) => {
                    const result = await next(query, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
                patch: async (next, query, values, context) => {
                    const result = await next(query, values, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
                delete: async (next, query, context) => {
                    const result = await next(query, context)
                    return { ...result, data: await relation.assignToResources(result.data) }
                },
            }
        })
        newPipeline.relations[name] = relation as any
        return newPipeline
    }

    /**
     * Get a readable description of what this pipeline does
     */
    toString(): string {
        return util.inspect(
            _.mapValues(this.schemaBuilders, (schema: SchemaBuilder<any>) => schema.schema),
            false,
            null,
        )
    }

    /**
     * Create new resources based on `resources` input array.
     *
     * @param resources An array of partial resources to be created
     * @param options Options that can alter the action behavior
     * @param context Context object
     */
    async create(resources: CV[], options?: CO, context?: CTX): Promise<ResultsInterface<M, CM>> {
        resources = _.cloneDeep(resources)
        options = _.cloneDeep(options ?? ({} as CO))
        context = _.cloneDeep(context ?? ({} as CTX))

        this.handleValidationOfData("create", "resources", this.schemaBuilders.createValues, resources)
        this.handleValidationOfData("create", "options", this.schemaBuilders.createOptions, options)
        this.handleValidationOfData("create", "context", this.schemaBuilders.context, context)

        return this.pipeChain("create")(resources, options, context)
    }

    /**
     * Create action placeholder
     * It should be overridden by child pipeline class
     */
    protected _create(resources: CV[], options: CO, context: CTX): Promise<ResultsInterface<M, CM>> {
        throw notImplementedError("create", Object.getPrototypeOf(this).constructor.name)
    }

    /**
     * Extract a standalone create function.
     * It can be used as a parameter for pipes to isolate dependencies and ease constraints definition
     */
    getCreateFunction() {
        return this.create.bind(this) as PipelineCreateFunction<M, CV, CO, CM, CTX>
    }

    /**
     * Read resources from the underlying source according to the given `query`.
     *
     * @param query The query filter to be used for fetching the data
     * @param context Context object
     */
    async read(query: RQ, context?: CTX): Promise<ResultsInterface<M, RM>> {
        query = _.cloneDeep(query)
        context = _.cloneDeep(context ?? ({} as CTX))

        this.handleValidationOfData("read", "query", this.schemaBuilders.readQuery, query)
        this.handleValidationOfData("read", "context", this.schemaBuilders.context, context)

        return this.pipeChain("read")(query, context)
    }

    /**
     * Read action placeholder
     * It should be overridden by child pipeline class
     */
    protected _read(query: RQ, context: CTX): Promise<ResultsInterface<M, RM>> {
        throw notImplementedError("read", Object.getPrototypeOf(this).constructor.name)
    }

    /**
     * Extract a standalone read function.
     * It can be used as a parameter for pipes to isolate dependencies and ease constraints definition
     */
    getReadFunction() {
        return this.read.bind(this) as PipelineReadFunction<M, RQ, RM, CTX>
    }

    /**
     * Patch resources according to the given query and values.
     * The `query` will select a subset of the underlying data source and `values` are updated on it.
     * This method should follow the JSON merge patch standard if possible. @see https://tools.ietf.org/html/rfc7396
     *
     * @param query
     * @param values
     * @param context Context object
     */
    async patch(query: PQ, values: PV, context?: CTX): Promise<ResultsInterface<M, PM>> {
        query = _.cloneDeep(query)
        values = _.cloneDeep(values)
        context = _.cloneDeep(context ?? ({} as CTX))

        this.handleValidationOfData("patch", "query", this.schemaBuilders.patchQuery, query)
        this.handleValidationOfData("patch", "values", this.schemaBuilders.patchValues, values)
        this.handleValidationOfData("patch", "context", this.schemaBuilders.context, context)

        return this.pipeChain("patch")(query, values, context)
    }

    /**
     * Patch action placeholder
     * It should be overridden by child pipeline class
     */
    protected _patch(query: PQ, values: PV, context: CTX): Promise<ResultsInterface<M, PM>> {
        throw notImplementedError("patch", Object.getPrototypeOf(this).constructor.name)
    }

    /**
     * Extract a standalone patch function.
     * It can be used as a parameter for pipes to isolate dependencies and ease constraints definition
     */
    getPatchFunction() {
        return this.patch.bind(this) as PipelinePatchFunction<M, PQ, PV, PM, CTX>
    }

    /**
     * Delete resources that match th given Query.
     * @param query The query filter to be used for selecting resources to delete
     * @param context Context object
     */
    async delete(query: DQ, context?: CTX): Promise<ResultsInterface<M, DM>> {
        query = _.cloneDeep(query)
        context = _.cloneDeep(context ?? ({} as CTX))

        this.handleValidationOfData("delete", "query", this.schemaBuilders.deleteQuery, query)
        this.handleValidationOfData("delete", "context", this.schemaBuilders.context, context)

        return this.pipeChain("delete")(query, context)
    }

    /**
     * Delete action placeholder
     * It should be overridden by child pipeline class
     */
    protected _delete(query: DQ, context: CTX): Promise<ResultsInterface<M, DM>> {
        throw notImplementedError("delete", Object.getPrototypeOf(this).constructor.name)
    }

    /**
     * Extract a standalone delete function.
     * It can be used as a parameter for pipes to isolate dependencies and ease constraints definition
     */
    getDeleteFunction() {
        return this.delete.bind(this) as PipelineDeleteFunction<M, DQ, DM, CTX>
    }

    private handleValidationOfData(method: string, valueName: string, schema: SchemaBuilder<any>, data: any) {
        if (!this.options.validationEnabled) {
            return
        }
        try {
            if (Array.isArray(data)) {
                schema.validateList(data)
            } else {
                schema.validate(data)
            }
        } catch (e) {
            throw error(
                "SerafinValidationError",
                `Validation failed in ${Object.getPrototypeOf(this).constructor.name}${
                    this.options.name ? `::${this.options.name}` : ""
                }::${method}(${valueName})`,
                { constructor: Object.getPrototypeOf(this).constructor.name, method: method, schema: schema, data: data },
                e,
            )
        }
    }

    clone(): this {
        let clonedPipeline = _.cloneDeepWith(this, (value: any, key: number | string | undefined) => {
            if (key === "relations" || key === "schemaBuilders" || key === "pipes") {
                // shallow clone
                return _.clone(value)
            }
        })
        return clonedPipeline
    }
}
