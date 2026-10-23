import { CreateOrganization } from '@tula-tech/nextjs'

/** A form that makes an organization and makes it the active one. */
export default function NewTeam() {
  return <CreateOrganization afterCreateUrl='/team' />
}
